import { useEffect, useMemo, useRef, useState } from 'react';
import { getLatestTradingSessionDate, isMarketSessionTime } from '@/lib/marketSession';
import type { Underlying } from '@/lib/underlyings';
import { combineMonths, type FuturesMonth, type FuturesSeries } from '../options-scanner/futuresModel';
import { parseMarketFile, type ContractMarket } from '../options-scanner/contractScanModel';
import { describeStale } from './dataAge';

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

  // A hidden tab stops polling on purpose; when it comes back the owner must
  // not wait up to a minute to see today's numbers again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setTick(value => value + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Self-heal: a visible tab holding a reading older than the rebuild cadence
  // asks again every 15s instead of once a minute.
  const stale = market != null && describeStale(market.at).stale;
  useEffect(() => {
    if (!stale) return undefined;
    const timer = window.setInterval(() => {
      if (visible()) setTick(value => value + 1);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [stale, market?.at]);

  return { market, loading: !market, error, status, rescan: () => setTick(value => value + 1) };
}

/** A live futures tick from the server's spot stream — the broker's number, not a minute close. */
export interface LiveFutureTick { ltp: number; at: number }

/**
 * Live futures ticks for a small list (the big cards). The board's minute
 * closes trail a broker's live quote by up to a couple of minutes, which reads
 * as a wrong price on a fast mover; the server already streams the feed's own
 * readings, so the cards quote those instead.
 */
export function useLiveFutures(symbols: readonly string[]): ReadonlyMap<string, LiveFutureTick> {
  const key = symbols.slice(0, 12).join(',');
  const [ticks, setTicks] = useState<ReadonlyMap<string, LiveFutureTick>>(() => new Map());
  useEffect(() => {
    if (!key || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource(`${API}/api/stream/spots?symbols=${encodeURIComponent(key)}`);
    source.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as { t?: number; futures?: Record<string, { ltp?: number; at?: number | null }> };
        const next = new Map<string, LiveFutureTick>();
        for (const [symbol, reading] of Object.entries(payload.futures ?? {})) {
          const ltp = Number(reading?.ltp);
          if (Number.isFinite(ltp) && ltp > 0) next.set(symbol, { ltp, at: Number(reading?.at) || Number(payload.t) || Date.now() });
        }
        if (next.size) setTicks(next);
      } catch { /* a malformed frame is ignored, the next one arrives in 3s */ }
    };
    return () => source.close();
  }, [key]);
  return ticks;
}

const WORKERS = 6;

/** Last successful futures per session/symbol; survives page tab unmounts. */
const futuresCache = new Map<string, FuturesSeries>();

const futuresCacheKey = (session: string, symbol: string) => `${session}|${symbol}`;

export function getCachedFutures(session: string, symbol: string): FuturesSeries | null {
  return futuresCache.get(futuresCacheKey(session, symbol)) ?? null;
}

export function putCachedFutures(session: string, symbol: string, series: FuturesSeries | null): void {
  if (series) futuresCache.set(futuresCacheKey(session, symbol), series);
}

export function deleteCachedFutures(session: string, symbol: string): void {
  futuresCache.delete(futuresCacheKey(session, symbol));
}

export function clearFuturesCache(): void {
  futuresCache.clear();
}

function futuresForSession(session: string, symbols: readonly string[]): ReadonlyMap<string, FuturesSeries> {
  const cached = new Map<string, FuturesSeries>();
  for (const symbol of symbols) {
    const series = getCachedFutures(session, symbol);
    if (series) cached.set(symbol, series);
  }
  return cached;
}

const EMPTY_FUTURES = new Map<string, FuturesSeries | null>();

/** Each underlying's futures: read six at a time, and again every minute or two while the numbers move. */
export function useFuturesFeed(symbols: readonly string[], enabled: boolean, status: FeedStatus | null) {
  const initialSession = status?.session ?? getLatestTradingSessionDate(new Date());
  const initialKey = symbols.join(',');
  const initialScopeKey = `${initialSession}|${initialKey}`;
  const cachedForScope = useMemo(() => futuresForSession(initialSession, symbols), [initialSession, initialKey]);
  const [seriesState, setSeriesState] = useState<{ key: string; values: ReadonlyMap<string, FuturesSeries | null> }>(() => ({ key: initialScopeKey, values: cachedForScope }));
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [doneState, setDoneState] = useState<{ key: string; value: number }>(() => ({ key: initialScopeKey, value: cachedForScope.size }));
  const [tick, setTick] = useState(0);
  // The provider's session: today's, or the recorded day it replays.
  const session = status?.session ?? getLatestTradingSessionDate(new Date());
  const key = symbols.join(',');
  const scopeKey = `${session}|${key}`;
  const statusRef = useRef(status);
  statusRef.current = status;
  const localSeries = seriesState.key === scopeKey ? seriesState.values : EMPTY_FUTURES;
  const series = useMemo(() => {
    const visible = new Map<string, FuturesSeries | null>(cachedForScope);
    for (const [symbol, reading] of localSeries) visible.set(symbol, reading);
    return visible;
  }, [cachedForScope, localSeries]);
  const done = doneState.key === scopeKey ? doneState.value : cachedForScope.size;

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
    const cachedAtStart = futuresForSession(session, symbols);
    const cachedSymbols = new Set(cachedAtStart.keys());
    // A warm remount starts at the cached coverage; only misses count up during this pass.
    if (tick === 0) {
      setSeriesState({ key: scopeKey, values: cachedAtStart });
      setDoneState({ key: scopeKey, value: cachedAtStart.size });
    }
    const read = async (symbol: string) => {
      let result: FuturesSeries | null = null;
      let ok = true;
      try { result = await fetchFutures(symbol, session); } catch { ok = false; }
      if (cancelled) return;
      if (ok) {
        if (result) putCachedFutures(session, symbol, result);
        else deleteCachedFutures(session, symbol);
        setSeriesState(current => {
          const base = current.key === scopeKey ? current.values : cachedAtStart;
          return { key: scopeKey, values: new Map(base).set(symbol, result) };
        });
        setFailed(current => {
          if (!current.has(symbol)) return current;
          const next = new Set(current);
          next.delete(symbol);
          return next;
        });
      } else {
        // A failed refresh leaves the last good reading visible.
        setFailed(current => {
          if (current.has(symbol)) return current;
          const next = new Set(current);
          next.add(symbol);
          return next;
        });
      }
      if (tick === 0 && !cachedSymbols.has(symbol)) {
        setDoneState(current => {
          const value = current.key === scopeKey ? current.value : cachedAtStart.size;
          return { key: scopeKey, value: Math.min(symbols.length, value + 1) };
        });
      }
    };
    const worker = async () => { while (cursor < symbols.length && !cancelled) await read(symbols[cursor++]); };
    void Promise.all(Array.from({ length: Math.min(WORKERS, symbols.length) }, worker));
    return () => { cancelled = true; };
    // `key` stands for the symbol list.
  }, [key, enabled, session, tick]);

  const failedForScope = useMemo(() => new Set([...failed].filter(symbol => symbols.includes(symbol))), [failed, key]);
  return { series, failed: failedForScope, read: tick === 0 ? Math.min(done, symbols.length) : symbols.length, total: symbols.length, session };
}

export type { Underlying };
