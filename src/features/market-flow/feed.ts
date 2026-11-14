import { useEffect, useRef, useState } from 'react';
import { getLatestTradingSessionDate, isMarketSessionTime } from '@/lib/marketSession';
import type { Underlying } from '@/lib/underlyings';
import { combineMonths, type FuturesMonth, type FuturesSeries } from '../options-scanner/futuresModel';
import { parseMarketFile, type ContractMarket } from '../options-scanner/contractScanModel';

/**
 * The page's data, all from its own server (server/index.mjs), whichever
 * provider feeds it: the market file every minute, and each underlying's
 * futures. Nothing here knows which broker (or the demo) is behind it.
 */

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export interface FeedStatus {
  provider: { id: string; label: string; alwaysLive: boolean };
  ready: boolean;
  /** The session the server's provider is on: today's, or a recorded day being replayed. */
  session?: string;
  lastError: { message: string } | null;
}

let statusPromise: Promise<FeedStatus | null> | null = null;
/** Which provider is behind the server; read once per visit. */
export function feedStatus(): Promise<FeedStatus | null> {
  statusPromise ??= fetch(`${API}/api/status`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  return statusPromise;
}

export function useFeedStatus(): FeedStatus | null {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  useEffect(() => { let live = true; void feedStatus().then(s => { if (live) setStatus(s); }); return () => { live = false; }; }, []);
  return status;
}

/** True while the numbers can move: in market hours, or always for a provider that is always live (the demo). */
const moving = (status: FeedStatus | null) => Boolean(status?.provider.alwaysLive) || isMarketSessionTime(Date.now());
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export async function fetchMarket(signal?: AbortSignal): Promise<ContractMarket | null> {
  const res = await fetch(`${API}/api/market`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(res.status === 503 ? ((await res.json().catch(() => null))?.error ?? 'The market is still loading.') : `Market ${res.status}`);
  return parseMarketFile(await res.json());
}

export async function fetchMarketMinute(date: string, minute: string, signal: AbortSignal | undefined, source: ReplaySource): Promise<ContractMarket | null> {
  const checkedSource = validateReplaySource(source);
  const root = checkedSource === 'archive' ? '/api/archive' : '/api/market';
  const path = checkedSource === 'archive' ? `${root}/${date}/minute/${minute}` : `${root}/${date}/${minute}`;
  const res = await fetch(`${API}${path}`, { signal });
  return res.ok ? parseMarketFile(await res.json()) : null;
}

export interface ReplayManifest {
  provider: { id: string; label: string };
  date: string;
  source: ReplaySource;
  minutes?: Array<[string, number]>;
  minutesIndex?: Array<[string, number]>;
  start: number | null;
  end: number | null;
  firstAt?: number | null;
  lastAt?: number | null;
  futures: Record<string, { available: boolean; months: string[]; firstAt: number | null; lastAt: number | null }>;
  futuresSymbols?: string[];
}

export type ReplaySource = 'live' | 'archive';

function validateReplaySource(source: unknown): ReplaySource {
  if (source === 'live' || source === 'archive') return source;
  throw new Error('Invalid replay source.');
}

export interface ReplayDay {
  date: string;
  source?: string;
  minutes: number;
  firstAt: number | null;
  lastAt: number | null;
  futuresSymbols: string[];
}

/** Runtime validation for catalog data. Unknown or missing sources are never live. */
export function sourceForDay(day: Pick<ReplayDay, 'source'> | null | undefined): ReplaySource | null {
  return day?.source === 'archive' || day?.source === 'live' ? day.source : null;
}

export async function fetchReplayDays(signal?: AbortSignal): Promise<ReplayDay[]> {
  const res = await fetch(`${API}/api/replay/days`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`Replay catalog ${res.status}`);
  const body = await res.json() as ReplayDay[];
  return Array.isArray(body) ? body.filter(day => day && typeof day.date === 'string') : [];
}

export async function fetchReplayManifest(date: string, signal: AbortSignal | undefined, source: ReplaySource): Promise<ReplayManifest | null> {
  const checkedSource = validateReplaySource(source);
  const root = checkedSource === 'archive' ? '/api/archive' : '/api/replay';
  const res = await fetch(`${API}${root}/${encodeURIComponent(date)}/manifest`, { cache: 'no-store', signal });
  if (!res.ok) return null;
  const body = await res.json() as ReplayManifest & { provider?: { id: string; label: string } | string };
  const provider = typeof body.provider === 'string' ? { id: body.provider, label: body.provider } : body.provider ?? { id: checkedSource, label: checkedSource };
  return { ...body, provider, futures: body.futures ?? {}, source: checkedSource, minutes: body.minutes ?? body.minutesIndex ?? [] };
}

export async function fetchReplayFutures(symbol: string, date: string, asOf: string, signal: AbortSignal | undefined, source: ReplaySource): Promise<FuturesSeries | null> {
  const checkedSource = validateReplaySource(source);
  const root = checkedSource === 'archive' ? '/api/archive' : '/api/replay';
  const res = await fetch(`${API}${root}/${encodeURIComponent(date)}/futures/${encodeURIComponent(symbol)}?asOf=${encodeURIComponent(asOf)}`, { cache: 'no-store', signal });
  if (!res.ok) return null;
  const body = await res.json() as { symbol?: string; months?: FuturesMonth[] };
  return combineMonths(body.symbol ?? symbol, body.months ?? []);
}

export async function fetchFutures(symbol: string, session: string): Promise<FuturesSeries | null> {
  const res = await fetch(`${API}/api/futures/${encodeURIComponent(symbol)}?session=${session}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Futures ${symbol}: ${res.status}`);
  const body = await res.json() as { months: FuturesMonth[] };
  return combineMonths(symbol, body.months ?? []);
}

/** The market file, read again every minute while the numbers can move. */
export function useMarketFeed() {
  const status = useFeedStatus();
  const [market, setMarket] = useState<ContractMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    const controller = new AbortController();
    fetchMarket(controller.signal)
      .then(next => {
        if (!next) return;
        setError(null);
        // A file from an earlier session is not today's board; a reading older than the one held is ignored.
        if (next.date < (statusRef.current?.session ?? getLatestTradingSessionDate(new Date()))) return;
        setMarket(current => (current && next.at <= current.at ? current : next));
      })
      .catch(err => { if (!controller.signal.aborted) setError(String(err?.message ?? err)); });
    return () => controller.abort();
  }, [tick]);

  useEffect(() => {
    // Until the first file arrives, ask every five seconds; then once a minute while the numbers move.
    const timer = window.setInterval(() => {
      if (!visible()) return;
      if (!market || moving(statusRef.current)) setTick(value => value + 1);
    }, market ? 60_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [market]);

  return { market, loading: !market, error, status, rescan: () => setTick(value => value + 1) };
}

const WORKERS = 6;

/** Each underlying's futures: read six at a time, and again every minute or two while the numbers move. */
export function useFuturesFeed(symbols: readonly string[], enabled: boolean, status: FeedStatus | null) {
  const [series, setSeries] = useState<ReadonlyMap<string, FuturesSeries | null>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState(0);
  const [tick, setTick] = useState(0);
  // The provider's session: today's, or the recorded day it replays.
  const session = status?.session ?? getLatestTradingSessionDate(new Date());
  const key = symbols.join(',');
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!enabled) return undefined;
    const every = statusRef.current?.provider.alwaysLive ? 60_000 : 120_000;
    const timer = window.setInterval(() => { if (visible() && moving(statusRef.current)) setTick(value => value + 1); }, every);
    return () => window.clearInterval(timer);
  }, [enabled, status]);

  useEffect(() => {
    if (!enabled || !symbols.length) return undefined;
    let cancelled = false;
    let cursor = 0;
    // A first pass counts up from nothing; a refresh keeps the count full and swaps the readings in place.
    if (tick === 0) setDone(0);
    const read = async (symbol: string) => {
      let result: FuturesSeries | null = null;
      let ok = true;
      try { result = await fetchFutures(symbol, session); } catch { ok = false; }
      if (cancelled) return;
      if (ok || tick === 0) setSeries(current => new Map(current).set(symbol, result));
      setFailed(current => {
        if (ok ? !current.has(symbol) : current.has(symbol)) return current;
        const next = new Set(current);
        if (ok) next.delete(symbol); else next.add(symbol);
        return next;
      });
      if (tick === 0) setDone(value => value + 1);
    };
    const worker = async () => { while (cursor < symbols.length && !cancelled) await read(symbols[cursor++]); };
    void Promise.all(Array.from({ length: Math.min(WORKERS, symbols.length) }, worker));
    return () => { cancelled = true; };
    // `key` stands for the symbol list.
  }, [key, enabled, session, tick]);

  return { series, failed, read: tick === 0 ? Math.min(done, symbols.length) : symbols.length, total: symbols.length, session };
}

export type { Underlying };
