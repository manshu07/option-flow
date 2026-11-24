import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { applyTheme } from '@/lib/applyTheme';
import { marketParts } from '@/lib/marketSession';
import { useRemembered, useRememberedChoice } from '@/lib/remembered';
import { clockOf } from '../market-flow/marketFlowModel';
import {
  filterObservationCards,
  formatPcrContext,
  formatPcrTable,
  highestObservedTarget,
  normalizeFollowThrough,
  paginateObservationCards,
  sortObservationCards,
  uniqueObservationCards,
  type ObservationCard,
  type ObservationFollowThrough,
  type ObservationTouch,
} from './observationModel';
import { normalizeLiveTicks } from './liveTicks';
import './observations.css';

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const OBSERVATIONS_URL = `${API}/api/observations`;
const SPOTS_STREAM_URL = `${API}/api/stream/spots`;
const MARKET_URL = `${API}/api/market`;
const POLL_MS = 30_000;
const PAGE_SIZES = ['10', '20', '30', '50', '100'] as const;
const PAGE_SIZE_OPTIONS: readonly CapsuleOption<(typeof PAGE_SIZES)[number]>[] = PAGE_SIZES.map(value => ({ value, label: value }));
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type ObservationView = 'cards' | 'table';
const SIGNAL_FILTERS = ['all', 'early', 'jev'] as const;
const SIGNAL_OPTIONS: readonly CapsuleOption<(typeof SIGNAL_FILTERS)[number]>[] = [
  { value: 'all', label: 'All' },
  { value: 'early', label: 'Early' },
  { value: 'jev', label: 'Jev' },
];
const CONFIDENCE_FILTERS = ['all', '65', '80'] as const;
const CONFIDENCE_OPTIONS: readonly CapsuleOption<(typeof CONFIDENCE_FILTERS)[number]>[] = [
  { value: 'all', label: 'Any %' },
  { value: '65', label: '65%+' },
  { value: '80', label: '80%+' },
];
const PCR_FILTERS = ['all', 'lt1', 'gte1'] as const;
const PCR_OPTIONS: readonly CapsuleOption<(typeof PCR_FILTERS)[number]>[] = [
  { value: 'all', label: 'All' },
  { value: 'lt1', label: 'PCR < 1' },
  { value: 'gte1', label: 'PCR ≥ 1' },
];
const CLUB_MODES = ['flat', 'symbol'] as const;
const CLUB_OPTIONS: readonly CapsuleOption<(typeof CLUB_MODES)[number]>[] = [
  { value: 'flat', label: 'Flat' },
  { value: 'symbol', label: 'Club by symbol' },
];
const OBSERVATION_VIEWS: readonly CapsuleOption<ObservationView>[] = [
  { value: 'cards', label: 'Cards' },
  { value: 'table', label: 'Table' },
];
const priceText = (value: number | null | undefined): string => Number.isFinite(value) ? value!.toFixed(2) : '—';
const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calendarDate(value: string | null | undefined) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const at = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) return null;
  return { day, month, ordinal: at / DAY_MS };
}

function daysToExpiry(cardDate: string, expiry: string | null): number | null {
  const from = calendarDate(cardDate), until = calendarDate(expiry);
  return from && until ? until.ordinal - from.ordinal : null;
}

function expiryDateLabel(expiry: string | null): string | null {
  const parsed = calendarDate(expiry);
  return parsed ? `${String(parsed.day).padStart(2, '0')}-${MONTHS[parsed.month - 1]}` : null;
}

function expiryLabel(cardDate: string, expiry: string | null): string | null {
  const date = expiryDateLabel(expiry);
  if (!date) return null;
  const dte = daysToExpiry(cardDate, expiry);
  return `${date}${dte == null ? '' : ` (${dte} DTE)`}`;
}

function istDateTime(at: number): { date: string; time: string } | null {
  if (!Number.isFinite(at)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  const day = get('day'), month = get('month'), hour = get('hour'), minute = get('minute');
  return day && month && hour && minute ? { date: `${day}-${month}`, time: `${hour}:${minute}` } : null;
}

function ageLabel(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

function dealerFlowSentence(gamma: ObservationCard['gamma']): string | null {
  if (!gamma || !Number.isFinite(gamma.flipLevel)) return null;
  const level = Math.round(gamma.flipLevel as number).toLocaleString('en-US');
  if (gamma.regime === 'gamma-long') return `📐 Dealer flow: RANGE above ${level} — breakouts likely to fade`;
  if (gamma.regime === 'gamma-short') return `📐 Dealer flow: TREND below ${level} — moves can accelerate`;
  return null;
}

function plainDealerNote(note: string): string {
  return note.replace(/\bmax-gamma strike\b/gi, 'highest dealer-flow strike')
    .replace(/\bgamma flip\b/gi, 'dealer-flow level')
    .replace(/\bgamma pin(?: zone)?\b/gi, 'dealer-flow zone')
    .replace(/\bgamma\b/gi, 'dealer flow');
}

function thetaWarning(dte: number | null): string | null {
  if (dte == null || dte > 7) return null;
  if (dte <= 2) return `⏳ ${dte} DTE — expiry-week decay is brutal; treat as a same-day trade only.`;
  return `⏳ ${dte} DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.`;
}

function flowLabel(card: ObservationCard): string {
  if (!Number.isFinite(card.gamma?.flipLevel)) return '—';
  if (card.gamma?.regime === 'gamma-long') return 'Range';
  if (card.gamma?.regime === 'gamma-short') return 'Trend';
  return '—';
}

/** Live tint zone: the tick decides while the card is open, the recorded
 *  outcome decides once the journal has resolved it. A touched target never un-tints. */
// Sticky achieved-zone memory: once TGT1/TGT2 is touched live, the card STAYS green —
// a later dip back into the buying range or even a post-target SL does not un-hit a
// target (owner rule 2026-11-23). Red is reserved for SL without a prior TGT1.
const achievedZone = new Map<string, 'tgt1' | 'tgt2'>();

function zoneFor(card: ObservationCard, opt: number | null | undefined, key: string): 'sl' | 'tgt1' | 'tgt2' | null {
  const ft = card.outcome?.followThrough;
  const bankedTgt2 = achievedZone.get(key) === 'tgt2' || !!ft?.touches?.tgt2;
  const bankedTgt1 = bankedTgt2 || achievedZone.get(key) === 'tgt1' || !!ft?.touches?.tgt1;
  if (card.outcome?.status && card.outcome.status !== 'open') {
    // Resolved: journal authority. SL resolves red ONLY when TGT1 was never hit first
    // (sl-first / none-observed). A target-first card stays green even if SL came later.
    if (card.outcome.status === 'sl') {
      const tgtFirst = ft?.sequence === 'target-first' || (bankedTgt1 && ft?.sequence !== 'sl-first');
      return tgtFirst ? (bankedTgt2 ? 'tgt2' : 'tgt1') : 'sl';
    }
    if (card.outcome.status === 'tgt1') return bankedTgt2 ? 'tgt2' : 'tgt1';
    return null;
  }
  // Open card: banked target kills the WHITE gap (dip back into buying range stays green),
  // but a live SL cross always shows red — tint follows the actual state, green pe green, red pe red.
  if (opt != null) {
    if (opt >= card.tgt2) achievedZone.set(key, 'tgt2');
    else if (opt >= card.tgt1 && achievedZone.get(key) !== 'tgt2') achievedZone.set(key, 'tgt1');
    if (opt <= card.sl) return 'sl';
    const achieved = achievedZone.get(key);
    if (achieved) return achieved;
    return null;
  }
  return bankedTgt2 ? 'tgt2' : bankedTgt1 ? 'tgt1' : null;
}

function outcomeLabel(card: ObservationCard): string {
  switch (card.outcome?.status) {
    case 'tgt1': return 'TGT1';
    case 'sl': return 'SL';
    case 'open': return 'Open';
    case 'ambiguous': return 'Ambiguous';
    default: return '—';
  }
}

function parseClubSections(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).filter(([symbol, expanded]) => symbol.length > 0 && typeof expanded === 'boolean'));
}

function clubOutcomeSummary(cards: readonly ObservationCard[]): string {
  const counts = { sl: 0, tgt1: 0, open: 0, ambiguous: 0 };
  for (const card of cards) {
    const status = card.outcome?.status ?? 'open';
    if (status === 'sl') counts.sl++;
    else if (status === 'tgt1') counts.tgt1++;
    else if (status === 'ambiguous') counts.ambiguous++;
    else if (status === 'open') counts.open++;
    else counts.open++;
  }
  return [
    counts.sl ? `${counts.sl} SL` : null,
    counts.tgt1 ? `${counts.tgt1} TGT1` : null,
    counts.open ? `${counts.open} open` : null,
    counts.ambiguous ? `${counts.ambiguous} ambiguous` : null,
  ].filter(Boolean).join(' · ') || 'no outcomes';
}

function clubBySymbol(cards: readonly ObservationCard[]) {
  const grouped = new Map<string, ObservationCard[]>();
  for (const card of cards) {
    if (!grouped.has(card.symbol)) grouped.set(card.symbol, []);
    grouped.get(card.symbol)!.push(card);
  }
  return [...grouped.entries()].map(([symbol, items]) => ({
    symbol,
    cards: items.sort((a, b) => b.at - a.at),
  })).sort((a, b) => b.cards[0].at - a.cards[0].at || a.symbol.localeCompare(b.symbol));
}

function captureTime(at: number | null): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'time unavailable';
  const stamped = istDateTime(at);
  return stamped ? `${stamped.date} ${stamped.time} IST` : 'time unavailable';
}

function touchText(touch: ObservationTouch | null, report: ObservationFollowThrough): string {
  if (!touch) return report.coverage === 'complete' ? 'Not observed' : 'Insufficient data';
  if (touch.source === 'day-range') return `Touch observed · range interval (${captureTime(touch.after)}–${captureTime(touch.at)}]`;
  return `Touch observed · capture ${captureTime(touch.at)}`;
}

function verificationBody(report: ObservationFollowThrough | null, rawReport: unknown) {
  if (!rawReport) return <p className="obs-verification__fallback">Post-call evidence unavailable; no sampled verification is attached.</p>;
  if (!report) return <p className="obs-verification__fallback">Post-call evidence unavailable; the saved report is invalid.</p>;

  const target = highestObservedTarget(report);
  const incomplete = report.coverage !== 'complete';
  return (
    <>
      <p className="obs-verification__notice">
        Captured observations only — not exchange OHLC and not execution fills.
        {incomplete && ` Coverage is ${report.coverage}; ${report.missingMinutes} minute sample${report.missingMinutes === 1 ? '' : 's'} are missing, so absence does not prove a level was not hit.`}
      </p>
      <dl className="obs-verification__stats">
        <div><dt>Post-call sampled O/H/L/C</dt><dd>{[report.range.open, report.range.high, report.range.low, report.range.close].map(priceText).join(' / ')}</dd></div>
        <div><dt>Captures</dt><dd>{captureTime(report.firstAt)} → {captureTime(report.lastAt)}</dd></div>
        <div><dt>Samples</dt><dd>{report.sampleCount}/{report.expectedMinutes} minutes · {report.source}</dd></div>
        {report.futures && <div title={`Captured full minutes: ${captureTime(report.futures.from)} → ${captureTime(report.futures.to)}`}>
          <dt>Futures after entry:</dt><dd>H {priceText(report.futures.high)} / L {priceText(report.futures.low)}</dd>
        </div>}
      </dl>
      <ul className="obs-verification__touches">
        <li><b>SL</b> {touchText(report.touches.sl, report)}</li>
        <li><b>TGT1</b> {touchText(report.touches.tgt1, report)}</li>
        <li><b>TGT2</b> {touchText(report.touches.tgt2, report)}</li>
      </ul>
      {target && <p className="obs-verification__highest">Highest target observed: {target.toUpperCase()} (legacy journal status is unchanged).</p>}
      {report.sequence === 'sl-first' && (report.touches.tgt1 || report.touches.tgt2) && (
        <p className="obs-verification__warning">SL was observed first. Later target touches are post-SL price movement, not a successful trade.</p>
      )}
      {report.sequence === 'ambiguous' && <p className="obs-verification__warning">SL/target order unknown; do not infer trade outcome from touch order.</p>}
    </>
  );
}

function OutcomeVerification({ card, table = false }: { card: ObservationCard; table?: boolean }) {
  const rawReport = card.outcome?.followThrough;
  const report = normalizeFollowThrough(rawReport);
  const content = verificationBody(report, rawReport);
  if (table) {
    return (
      <details className="obs-verification obs-verification--table">
        <summary>{outcomeLabel(card)}</summary>
        <div className="obs-verification__body"><p className="obs-verification__journal">Recorded journal status: <b>{outcomeLabel(card)}</b></p>{content}</div>
      </details>
    );
  }
  return (
    <section className="obs-verification" aria-label="Post-call verification">
      <div className="obs-verification__title"><b>Post-call verification</b><span>Recorded journal status: <b>{outcomeLabel(card)}</b></span></div>
      {content}
    </section>
  );
}

interface SpotReading { sp: number; pc: number; changePct: number | null }

type SpotMap = Map<string, SpotReading>;

/** Live spots + contract ticks over server-sent events — the feed's tick
 *  readings, pushed ~3s. trackedSymbols adds futures ticks, trackedOptions
 *  (SYM|strike|SIDE|expiry) adds live option premiums. A one-shot /api/market
 *  fetch primes the map, and a slow poll takes over only while the stream is
 *  down. */
function useMarketSnapshot(trackedSymbols: string[], trackedOptions: string[]) {
  const [spots, setSpots] = useState<SpotMap>(new Map());
  const [futuresTicks, setFuturesTicks] = useState<Record<string, { ltp: number }>>({});
  const [optionTicks, setOptionTicks] = useState<Record<string, { ltp: number }>>({});
  const [asOf, setAsOf] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const symbolsKey = trackedSymbols.join(','), optionsKey = trackedOptions.join(',');
  useEffect(() => {
    let alive = true;
    const fromBody = (body: { t?: number; spots?: Record<string, { ltp?: number; prevClose?: number }>; futures?: unknown; optionTicks?: unknown }) => {
      const map: SpotMap = new Map();
      for (const [symbol, reading] of Object.entries(body.spots ?? {})) {
        const ltp = reading?.ltp;
        const prevClose = reading?.prevClose;
        if (typeof ltp === 'number' && Number.isFinite(ltp) && typeof prevClose === 'number' && Number.isFinite(prevClose) && prevClose > 0) {
          map.set(symbol, { sp: ltp, pc: prevClose, changePct: ((ltp - prevClose) / prevClose) * 100 });
        }
      }
      if (map.size) { setSpots(map); setAsOf(typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : null); setFailed(false); }
      if (body.futures !== undefined) setFuturesTicks(normalizeLiveTicks(body.futures));
      if (body.optionTicks !== undefined) setOptionTicks(normalizeLiveTicks(body.optionTicks));
    };
    // Prime once from the built snapshot (covers symbols the stream may not have yet).
    fetch(MARKET_URL, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
      if (!alive) return;
      const map: SpotMap = new Map();
      for (const series of body?.series ?? []) {
        if (Number.isFinite(series?.sp) && Number.isFinite(series?.pc) && series.pc > 0) {
          map.set(series.s, { sp: series.sp, pc: series.pc, changePct: ((series.sp - series.pc) / series.pc) * 100 });
        }
      }
      setSpots(map);
      setAsOf(Number.isFinite(body?.t) ? body.t : null);
    }).catch(() => { /* the stream or the next poll will fill in */ });
    const query = `?symbols=${encodeURIComponent(symbolsKey)}&options=${encodeURIComponent(optionsKey)}`;
    const source = new EventSource(SPOTS_STREAM_URL + query);
    source.onmessage = event => {
      if (!alive) return;
      try { fromBody(JSON.parse(event.data)); } catch { /* malformed frame — ignore */ }
    };
    source.onerror = () => { if (alive) setFailed(true); };
    const timer = setInterval(() => {
      if (!alive) return;
      fetch(MARKET_URL, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        const map: SpotMap = new Map();
        for (const series of body?.series ?? []) {
          if (Number.isFinite(series?.sp) && Number.isFinite(series?.pc) && series.pc > 0) {
            map.set(series.s, { sp: series.sp, pc: series.pc, changePct: ((series.sp - series.pc) / series.pc) * 100 });
          }
        }
        setSpots(map);
        setAsOf(Number.isFinite(body?.t) ? body.t : null);
      }).catch(() => { if (alive) setFailed(true); });
    }, 60_000);
    return () => { alive = false; source.close(); clearInterval(timer); };
  }, [symbolsKey, optionsKey]);
  return { spots, futuresTicks, optionTicks, asOf, failed };
}

interface FuturesSeries { at: number; close: number }

/** The card symbol's session futures line — the same persisted series the board charts. */
function useFutures(symbol: string | undefined) {
  const [closes, setCloses] = useState<FuturesSeries[] | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    setCloses(null);
    const read = () => {
      fetch(`${API}/api/futures/${encodeURIComponent(symbol)}`, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        const months = Array.isArray(body?.months) ? body.months : [];
        const candles = months[0]?.candles ?? [];
        setCloses(candles.filter((c: { at?: unknown; close?: unknown }) => Number.isFinite(c?.at) && Number.isFinite(c?.close)).map((c: { at: number; close: number }) => ({ at: c.at, close: c.close })));
      }).catch(() => { if (alive) setCloses(null); });
    };
    read();
    const timer = setInterval(read, 120_000);
    return () => { alive = false; clearInterval(timer); };
  }, [symbol]);
  return closes;
}

function Sparkline({ closes }: { closes: FuturesSeries[] | null }) {
  if (!closes || closes.length < 2) return <div className="obs-spark obs-spark--empty">futures line warming up…</div>;
  const width = 280, height = 54, pad = 4;
  const values = closes.map(c => c.close);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const points = closes.map((c, i) => `${pad + (i / (closes.length - 1)) * (width - pad * 2)},${height - pad - ((c.close - min) / span) * (height - pad * 2)}`);
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className={`obs-spark ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${closes.length} futures closes, session line`}>
      <polyline className="obs-spark__area" points={` ${pad},${height - pad} ${points.join(' ')} ${width - pad},${height - pad}`} />
      <polyline className="obs-spark__line" points={points.join(' ')} />
    </svg>
  );
}

function CardLive({ card, spots, futuresTick, optionTick, closes, zone }: {
  card: ObservationCard;
  spots: SpotMap;
  futuresTick?: { ltp: number };
  optionTick?: { ltp: number };
  closes: FuturesSeries[] | null;
  zone: 'sl' | 'tgt1' | 'tgt2' | null;
}) {
  const liveSpot = spots.get(card.symbol);
  const spot = liveSpot ?? (card.spot != null ? { sp: card.spot, changePct: card.spotChangePct ?? null } : null);
  const opt = optionTick?.ltp;
  return (
    <div className="obs-card__live">
      <Sparkline closes={closes} />
      <div className="obs-card__quote">
        <span className="obs-card__quote-symbol">{card.symbol}</span>
        {spot
          ? <><span className={`obs-card__quote-ltp ${spot.changePct != null && spot.changePct >= 0 ? 'is-up' : 'is-down'}`}>{priceText(spot.sp)}</span><span className={`obs-card__quote-chg ${spot.changePct != null && spot.changePct >= 0 ? 'is-up' : 'is-down'}`}>{spot.changePct != null ? `${spot.changePct >= 0 ? '+' : ''}${spot.changePct.toFixed(2)}%` : '—'}</span></>
          : <span className="obs-card__quote-chg">spot warming up…</span>}
        {futuresTick && <span className="obs-card__quote-sub" title="live futures price (~3s ticks)">fut {priceText(futuresTick.ltp)}</span>}
        {zone === 'sl'
          ? <span className="obs-card__quote-sub is-down" title="stop hit intraday — live premium tracking off">● SL hit — live price off</span>
          : <span className="obs-card__quote-sub" title="live option premium (~3s ticks) vs entry">
              {card.side} {opt != null ? <b className={opt >= card.entry ? 'is-up' : 'is-down'}>₹{priceText(opt)}</b> : `~₹${priceText(card.entry)}`} · entry ₹{priceText(card.entry)}
            </span>}
      </div>
    </div>
  );
}

type CardLiveTick = { ltp: number; oi?: number };
type CardProps = {
  card: ObservationCard;
  spots: SpotMap;
  futuresTicks: Record<string, CardLiveTick>;
  optionTicks: Record<string, CardLiveTick>;
};

const sameTick = (a?: CardLiveTick, b?: CardLiveTick) => a?.ltp === b?.ltp && a?.oi === b?.oi;
const sameOutcome = (a: ObservationCard['outcome'], b: ObservationCard['outcome']) => JSON.stringify(a) === JSON.stringify(b);

function effectiveSpot(props: CardProps) {
  const live = props.spots.get(props.card.symbol);
  return {
    sp: live?.sp ?? props.card.spot ?? null,
    changePct: live?.changePct ?? props.card.spotChangePct ?? null,
  };
}

function sameCardProps(previous: CardProps, next: CardProps): boolean {
  const a = previous.card;
  const b = next.card;
  if (a.id !== b.id || a.symbol !== b.symbol || a.strike !== b.strike || a.side !== b.side || a.expiry !== b.expiry) return false;
  if (!sameOutcome(a.outcome, b.outcome)) return false;
  const previousSpot = effectiveSpot(previous);
  const nextSpot = effectiveSpot(next);
  if (previousSpot.sp !== nextSpot.sp || previousSpot.changePct !== nextSpot.changePct) return false;
  const optionKey = `${a.symbol}|${a.strike}|${a.side}|${a.expiry}`;
  return sameTick(previous.futuresTicks[a.symbol], next.futuresTicks[b.symbol])
    && sameTick(previous.optionTicks[optionKey], next.optionTicks[optionKey])
    && a.oiChangePct === b.oiChangePct
    && a.support?.oi === b.support?.oi
    && a.support?.changePct === b.support?.changePct
    && a.resistance?.oi === b.resistance?.oi
    && a.resistance?.changePct === b.resistance?.changePct;
}

export const Card = memo(function Card({ card, spots, futuresTicks, optionTicks }: CardProps) {
  const up = card.bias === 'bullish';
  const closes = useFutures(card.symbol);
  const optionKey = `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
  const zone = zoneFor(card, optionTicks[optionKey]?.ltp, card.id);
  const dte = daysToExpiry(card.date, card.expiry);
  const expiry = expiryLabel(card.date, card.expiry);
  const stamped = istDateTime(card.at);
  const dealerFlow = dealerFlowSentence(card.gamma);
  const theta = thetaWarning(dte);
  return (
    <article className={`obs-card ${up ? 'obs-card--bull' : 'obs-card--bear'}${zone ? ` obs-card--zone-${zone}` : ''}`}>
      <header className="obs-card__head">
        <h3 className="obs-card__symbol">{card.symbol}</h3>
        <span className={`obs-card__contract ${up ? 'is-up' : 'is-down'}`}>{card.strike}{card.side}{expiry ? ` · ${expiry}` : ''}</span>
        <span className={`obs-card__bias ${up ? 'is-up' : 'is-down'}`}>{up ? 'bullish' : 'bearish'} · {card.reEntry ? 'RE-ENTRY' : card.early ? `EARLY (${card.early})` : Number.isFinite(card.quality) ? `quality ${(card.quality * 100).toFixed(0)}%` : 'quality unavailable'}</span>
        <time className="obs-card__time" dateTime={Number.isFinite(card.at) ? new Date(card.at).toISOString() : undefined}>
          {stamped ? `${stamped.date} · ${stamped.time} IST · ${ageLabel(card.at, Date.now())}` : 'Timestamp unavailable'}
        </time>
      </header>
      <CardLive card={card} spots={spots} futuresTick={futuresTicks[card.symbol]} optionTick={optionTicks[optionKey]} closes={closes} zone={zone} />
      <dl className="obs-card__levels">
        <div><dt>Entry</dt><dd>~{priceText(card.entry)}</dd></div>
        <div className="is-down"><dt>SL −45%</dt><dd>{priceText(card.sl)}</dd></div>
        <div className="is-up"><dt>TGT1 +55%</dt><dd>{priceText(card.tgt1)}</dd></div>
        <div className="is-up"><dt>TGT2 +90%</dt><dd>{priceText(card.tgt2)}</dd></div>
      </dl>
      <p className="obs-card__pcr">{formatPcrContext(card.pcrAtEntry, card.pcrShift)}</p>
      <p className="obs-card__walls">
        {card.support && <span>support {card.support.strike} PE ({(card.support.oi / 1_000_000).toFixed(1)}M{card.support.changePct != null ? ` ${card.support.changePct >= 0 ? '+' : ''}${card.support.changePct.toFixed(2)}%` : ''})</span>}
        {card.resistance && <span>resistance {card.resistance.strike} CE ({(card.resistance.oi / 1_000_000).toFixed(1)}M{card.resistance.changePct != null ? ` ${card.resistance.changePct >= 0 ? '+' : ''}${card.resistance.changePct.toFixed(2)}%` : ''})</span>}
        <span className="obs-card__tsl">{card.tsl}</span>
      </p>
      {card.gamma && <div className="obs-card__gamma">
        {dealerFlow && <p>{dealerFlow}{card.gamma.pin ? ` · pin ${card.gamma.pin}` : ''}</p>}
        {(card.gamma.notes ?? []).map(note => <small key={note}>{plainDealerNote(note)}</small>)}
      </div>}
      {theta && <p className="obs-card__theta">{theta}</p>}
      <OutcomeVerification card={card} />
      <footer className="obs-card__foot">{card.disclaimer}</footer>
    </article>
  );
}, sameCardProps);

function ObservationTable({ cards, optionTicks }: {
  cards: ObservationCard[];
  optionTicks: Record<string, { ltp: number }>;
}) {
  return (
    <div className="observations__table-wrap">
      <table className="observations__table">
        <thead><tr>
          <th>Time</th><th>Symbol</th><th>Contract</th><th>Expiry</th><th>DTE</th><th>Bias</th><th>Quality</th><th>PCR</th>
          <th>Entry</th><th>SL</th><th>TGT1</th><th>TGT2</th><th>Live opt</th><th>Flow</th><th>Status</th>
        </tr></thead>
        <tbody>{cards.map(card => {
          const stamped = istDateTime(card.at);
          const dte = daysToExpiry(card.date, card.expiry);
          const optionKey = `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
          const liveOption = optionTicks[optionKey]?.ltp;
          const zone = zoneFor(card, liveOption, card.id);
          return (
            <tr key={card.id} className={zone ? `obs-row--zone-${zone}` : undefined}>
              <td>{stamped ? `${stamped.date} ${stamped.time}` : '—'}</td>
              <td>{card.symbol}</td>
              <td>{card.strike}{card.side}</td>
              <td>{expiryDateLabel(card.expiry) ?? '—'}</td>
              <td className="is-numeric">{dte ?? '—'}</td>
              <td className={card.bias === 'bullish' ? 'is-up' : 'is-down'}>{card.bias}</td>
              <td className="is-numeric">{card.reEntry ? 'RE-ENTRY' : card.early ? `early · ${card.early}` : Number.isFinite(card.quality) ? `${(card.quality * 100).toFixed(0)}%` : '—'}</td>
              <td className="is-numeric">{formatPcrTable(card.pcrAtEntry, card.pcrShift)}</td>
              <td className="is-numeric">{priceText(card.entry)}</td>
              <td className="is-numeric">{priceText(card.sl)}</td>
              <td className="is-numeric">{priceText(card.tgt1)}</td>
              <td className="is-numeric">{priceText(card.tgt2)}</td>
              <td className="is-numeric">{Number.isFinite(liveOption) ? priceText(liveOption as number) : '—'}</td>
              <td>{flowLabel(card)}</td>
              <td><OutcomeVerification card={card} table /></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function IndexStrip({ spots, futuresTicks, asOf, failed }: { spots: SpotMap; futuresTicks: Record<string, { ltp: number }>; asOf: number | null; failed: boolean }) {
  return (
    <div className="obs-indices" role="status" aria-live="polite">
      {INDEX_SYMBOLS.map(symbol => {
        const spot = spots.get(symbol);
        const fut = futuresTicks[symbol]?.ltp;
        const up = (spot?.changePct ?? 0) >= 0;
        return (
          <span key={symbol} className="obs-index">
            <span className="obs-index__name">{symbol === 'NIFTY' ? 'Nifty' : symbol === 'BANKNIFTY' ? 'BankNifty' : 'Sensex'}</span>
            {spot
              ? <><span className={`obs-index__ltp ${up ? 'is-up' : 'is-down'}`}>{priceText(spot.sp)}</span><span className={`obs-index__chg ${up ? 'is-up' : 'is-down'}`}>{up ? '▲' : '▼'} {Math.abs(spot.changePct ?? 0).toFixed(2)}%</span></>
              : <span className="obs-index__ltp">—</span>}
            {fut != null && <span className="obs-index__fut" title="live futures price — ticks every ~3s (Dhan's feed does not stream index spot)">fut {priceText(fut)}</span>}
          </span>
        );
      })}
      <span className="obs-indices__asof">{failed ? 'spot feed retrying…' : asOf ? `live · ${clockOf(asOf)}` : ''}</span>
    </div>
  );
}

export function ObservationsPage({ tabs }: { tabs?: ReactNode }) {
  const [cards, setCards] = useState<ObservationCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useRememberedChoice('observations-view:v1', ['cards', 'table'] as const, 'cards');
  const [clubMode, setClubMode] = useRememberedChoice('observations-club-by-symbol:v1', CLUB_MODES, 'flat');
  const [clubSections, setClubSections] = useRemembered('observations-club-sections:v1', parseClubSections, {});
  const [page, setPage] = useState(1);
  const [pageSizeChoice, setPageSizeChoice] = useRememberedChoice('observations.pageSize:v1', PAGE_SIZES, '10');
  const [signal, setSignal] = useRememberedChoice('observations.signal:v1', SIGNAL_FILTERS, 'all');
  const [confidence, setConfidence] = useRememberedChoice('observations.confidence:v1', CONFIDENCE_FILTERS, 'all');
  const [pcrFilter, setPcrFilter] = useRememberedChoice('observations.pcr:v1', PCR_FILTERS, 'all');
  const [search, setSearch] = useRemembered('observations.search:v1', raw => (typeof raw === 'string' ? raw : undefined), '');
  const pageSize = Number(pageSizeChoice) || 10;
  const todayDate = marketParts(Date.now()).dateKey;
  const todayCount = cards?.filter(card => card.date === todayDate).length ?? 0;
  const filtered = useMemo(
    () => (cards == null ? null : filterObservationCards(cards, { signal, confidence, pcr: pcrFilter, query: search })),
    [cards, signal, confidence, pcrFilter, search],
  );
  const pageData = filtered == null ? null : paginateObservationCards(filtered, page, pageSize);
  const clubs = useMemo(() => pageData ? clubBySymbol(pageData.items) : [], [pageData]);
  useEffect(() => { setPage(1); }, [cards?.length, view, pageSize, signal, confidence, pcrFilter, search]);
  // Always track the three indices' futures; add every card symbol + its exact option contract.
  const trackedSymbols = useMemo(
    () => [...new Set([...INDEX_SYMBOLS, ...(cards ?? []).map(card => card.symbol)])],
    [cards],
  );
  // Today's cards AND every still-open card get option-tick streams: an open
  // card may be a live position, so its premium must keep ticking even days
  // later. Closed cards skip the stream (their outcome is already final).
  const trackedOptions = useMemo(
    () => (cards ?? []).filter(card => card.expiry && (card.date === todayDate || card.outcome?.status === 'open' || card.outcome == null)).map(card => `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`),
    [cards, todayDate],
  );
  const { spots, futuresTicks, optionTicks, asOf, failed: spotFailed } = useMarketSnapshot(trackedSymbols, trackedOptions);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetch(OBSERVATIONS_URL).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        const ordered = sortObservationCards<ObservationCard>(Array.isArray(body?.cards) ? body.cards : []);
        setCards(uniqueObservationCards(ordered));
        setFailed(false);
      }).catch(() => { if (alive) setFailed(true); });
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const bar = (
    <>
      {tabs}
      <CapsuleSegmented
        options={OBSERVATION_VIEWS}
        value={view}
        onChange={next => { setView(next); setPage(1); }}
        ariaLabel="Observation view"
        groupId="observations-view"
        size="page"
      />
      <CapsuleSegmented
        options={CLUB_OPTIONS}
        value={clubMode}
        onChange={next => { setClubMode(next); setPage(1); }}
        ariaLabel="Club cards by symbol"
        groupId="observations-club-by-symbol"
        size="page"
      />
      <CapsuleSegmented
        options={SIGNAL_OPTIONS}
        value={signal}
        onChange={next => { setSignal(next); setPage(1); }}
        ariaLabel="Signal source"
        groupId="observations-signal"
        size="page"
      />
      <CapsuleSegmented
        options={CONFIDENCE_OPTIONS}
        value={confidence}
        onChange={next => { setConfidence(next); setPage(1); }}
        ariaLabel="Minimum Jev confidence"
        groupId="observations-confidence"
        size="page"
      />
      <CapsuleSegmented
        options={PCR_OPTIONS}
        value={pcrFilter}
        onChange={next => { setPcrFilter(next); setPage(1); }}
        ariaLabel="PCR filter"
        groupId="observations-pcr"
        size="page"
      />
      <input
        type="search"
        className="observations__search"
        value={search}
        onChange={event => { setSearch(event.target.value); setPage(1); }}
        placeholder="Search symbol / strike…"
        aria-label="Search observations"
      />
      <span className="ui-flow-spacer" aria-hidden="true" />
      <ThemeToggle onChange={theme => applyTheme(theme)} />
    </>
  );
  return (
    <div className="observations">
      <PageBar current="Observations" crumbs={false} className="ui-flow-pagebar">{bar}</PageBar>
      <IndexStrip spots={spots} futuresTicks={futuresTicks} asOf={asOf} failed={spotFailed} />
      <div className="observations__status mf-status" role="status" aria-live="polite">
        {failed
          ? <span className="is-down">Observations could not be loaded — retrying every 30s.</span>
          : cards == null
            ? <span>Reading observations…</span>
            : <span><b>{todayCount}</b> today · <b>{cards.length - todayCount}</b> saved history · advisor re-reads watched symbols every 10 minutes · buy-side only</span>}
      </div>
      {cards != null && cards.length === 0 && (
        <div className="observations__list">
          <section className="observations__empty" role="status">
            <div><h2>No observations yet</h2><p>When the advisor promotes a build-up to a watch (quality ≥ 70%), its strike observation card appears here — with entry, stop and targets computed from the captured chain.</p></div>
          </section>
        </div>
      )}
      {cards != null && cards.length > 0 && pageData?.total === 0 && (
        <div className="observations__list">
          <section className="observations__empty" role="status">
            <div><h2>No matches</h2><p>No cards match the current search or filters — clear the search or widen the signal/confidence choice.</p></div>
          </section>
        </div>
      )}
      {view === 'cards' && pageData && pageData.total > 0 && (
        clubMode === 'flat'
          ? <div className="observations__list">
            {pageData.items.map(card => <Card key={card.id} card={card} spots={spots} futuresTicks={futuresTicks} optionTicks={optionTicks} />)}
          </div>
          : <div className="observations__list">
            {clubs.map(group => {
              const newest = group.cards[0];
              const optionKey = `${newest.symbol}|${newest.strike}|${newest.side}|${newest.expiry}`;
              const zone = zoneFor(newest, optionTicks[optionKey]?.ltp, newest.id);
              const expanded = clubSections[group.symbol] ?? true;
              const sectionId = `observations-club-${encodeURIComponent(group.symbol)}`;
              return (
                <section className="observations__club" key={group.symbol} data-testid="observations-club-section">
                  <button
                    type="button"
                    className="obs-card__head"
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--mf-line, #c9c9cf)', borderRadius: 9, background: 'var(--mf-panel, #fff)', textAlign: 'left', cursor: 'pointer' }}
                    aria-expanded={expanded}
                    aria-controls={sectionId}
                    onClick={() => setClubSections(current => ({ ...current, [group.symbol]: !expanded }))}
                  >
                    <span className="obs-card__symbol">{group.symbol}</span>
                    <span
                      className={`obs-card__bias ${newest.bias === 'bullish' ? 'is-up' : 'is-down'}${zone ? ` obs-card--zone-${zone}` : ''}`}
                      data-testid="observations-club-count"
                    >({group.cards.length})</span>
                    <span>— {clubOutcomeSummary(group.cards)}</span>
                    <span aria-hidden="true" style={{ marginLeft: 'auto' }}>{expanded ? '▾' : '▸'}</span>
                  </button>
                  {expanded && <div id={sectionId} className="observations__club-cards">
                    {group.cards.map(card => <Card key={card.id} card={card} spots={spots} futuresTicks={futuresTicks} optionTicks={optionTicks} />)}
                  </div>}
                </section>
              );
            })}
          </div>
      )}
      {view === 'table' && pageData && pageData.total > 0 && (clubMode === 'flat'
        ? <ObservationTable cards={pageData.items} optionTicks={optionTicks} />
        : <div className="observations__list">
          {clubs.map(group => {
            const newest = group.cards[0];
            const optionKey = `${newest.symbol}|${newest.strike}|${newest.side}|${newest.expiry}`;
            const zone = zoneFor(newest, optionTicks[optionKey]?.ltp, newest.id);
            const expanded = clubSections[group.symbol] ?? true;
            const sectionId = `observations-club-table-${encodeURIComponent(group.symbol)}`;
            return (
              <section className="observations__club" key={group.symbol} data-testid="observations-club-section">
                <button
                  type="button"
                  className="obs-card__head"
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--mf-line, #c9c9cf)', borderRadius: 9, background: 'var(--mf-panel, #fff)', textAlign: 'left', cursor: 'pointer' }}
                  aria-expanded={expanded}
                  aria-controls={sectionId}
                  onClick={() => setClubSections(current => ({ ...current, [group.symbol]: !expanded }))}
                >
                  <span className="obs-card__symbol">{group.symbol}</span>
                  <span
                    className={`obs-card__bias ${newest.bias === 'bullish' ? 'is-up' : 'is-down'}${zone ? ` obs-card--zone-${zone}` : ''}`}
                    data-testid="observations-club-count"
                  >({group.cards.length})</span>
                  <span>— {clubOutcomeSummary(group.cards)}</span>
                  <span aria-hidden="true" style={{ marginLeft: 'auto' }}>{expanded ? '▾' : '▸'}</span>
                </button>
                {expanded && <div id={sectionId} className="observations__club-table">
                  <ObservationTable cards={group.cards} optionTicks={optionTicks} />
                </div>}
              </section>
            );
          })}
        </div>)}
      {pageData && pageData.total > 0 && (
        <nav className="observations__pagination" aria-label="Observation pagination">
          <button type="button" onClick={() => setPage(Math.max(1, pageData.page - 1))} disabled={pageData.page <= 1}>‹ Prev</button>
          <span>{pageData.start}–{pageData.end} of {pageData.total}</span>
          <button type="button" onClick={() => setPage(Math.min(pageData.totalPages, pageData.page + 1))} disabled={pageData.page >= pageData.totalPages}>Next ›</button>
          <CapsuleSegmented
            options={PAGE_SIZE_OPTIONS}
            value={pageSizeChoice}
            onChange={next => { setPageSizeChoice(next); setPage(1); }}
            ariaLabel="Entries per page"
            groupId="observations-page-size"
            size="panel"
            className="observations__pagesize"
          />
        </nav>
      )}
    </div>
  );
}
