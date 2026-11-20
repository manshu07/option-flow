export type ObservationOutcomeStatus = 'tgt1' | 'sl' | 'open' | 'ambiguous';

export type FollowThroughCoverage = 'complete' | 'partial' | 'missing';
export type FollowThroughSequence = 'sl-first' | 'target-first' | 'ambiguous' | 'none-observed';

export interface ObservationTouch {
  at: number;
  after: number;
  source: 'ltp' | 'day-range';
}

export interface ObservationFuturesRange {
  high: number;
  low: number;
  /** Inclusive start and exclusive end of the included full-minute candles. */
  from: number;
  to: number;
}

export interface ObservationFollowThrough {
  version: 1;
  source: 'raw' | 'archive';
  from: number;
  sessionCloseAt: number;
  firstAt: number | null;
  lastAt: number | null;
  sampleCount: number;
  expectedMinutes: number;
  missingMinutes: number;
  coverage: FollowThroughCoverage;
  range: {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  };
  touches: {
    sl: ObservationTouch | null;
    tgt1: ObservationTouch | null;
    tgt2: ObservationTouch | null;
  };
  sequence: FollowThroughSequence;
  futures?: ObservationFuturesRange | null;
}

export interface ObservationOutcome {
  status?: ObservationOutcomeStatus;
  followThrough?: ObservationFollowThrough | null;
}

export interface ObservationGamma {
  gexAtStrike: number | null;
  distanceToFlip: number | null;
  regime: 'gamma-long' | 'gamma-short' | null;
  flipLevel: number | null;
  pin: string | null;
  notes: string[];
}

export interface ObservationCard {
  id: string;
  at: number;
  date: string;
  symbol: string;
  spot?: number | null;
  spotChangePct?: number | null;
  bias: 'bullish' | 'bearish';
  side: 'CE' | 'PE';
  strike: number;
  expiry: string | null;
  entry: number;
  sl: number;
  tgt1: number;
  tgt2: number;
  tsl: string;
  support: { strike: number; oi: number; changePct: number | null } | null;
  resistance: { strike: number; oi: number; changePct: number | null } | null;
  quality: number;
  strikePickProbability: number;
  /** Set on code-computed early cards: build-fast (OI ≥5%) or momentum (OI flat/negative). */
  early?: 'build-fast' | 'momentum' | null;
  /** Set on re-entry cards: one fresh card after an SL-hit contract recovers to cost. */
  reEntry?: number;
  oiChangePct: number | null;
  gamma?: ObservationGamma | null;
  atr?: { value: number; barMinutes: number; state: 'compressed' | 'normal' | 'expanded' } | null;
  outcome?: ObservationOutcome | null;
  disclaimer: string;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function timestamp(value: unknown): value is number {
  return finite(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function validNullableNumber(value: unknown): value is number | null {
  return value === null || finite(value);
}

function nullableNumber(value: unknown): number | null {
  return finite(value) ? value : null;
}

function normalizeTouch(value: unknown): ObservationTouch | null {
  if (!value || typeof value !== 'object') return null;
  const touch = value as Record<string, unknown>;
  return timestamp(touch.at) && timestamp(touch.after) && touch.after <= touch.at && (touch.source === 'ltp' || touch.source === 'day-range')
    ? { at: touch.at, after: touch.after, source: touch.source }
    : null;
}

function normalizeFuturesRange(value: unknown, from: number, closeAt: number): ObservationFuturesRange | null {
  if (!value || typeof value !== 'object') return null;
  const range = value as Record<string, unknown>;
  if (!finite(range.high) || !finite(range.low) || range.low <= 0 || range.high < range.low
    || !timestamp(range.from) || !timestamp(range.to)
    || range.from % 60_000 !== 0 || range.to % 60_000 !== 0
    || range.from < Math.ceil(from / 60_000) * 60_000 || range.to <= range.from || range.to > closeAt) return null;
  return { high: range.high, low: range.low, from: range.from, to: range.to };
}

/** Parse the persisted report without allowing malformed evidence to break card rendering. */
export function normalizeFollowThrough(value: unknown): ObservationFollowThrough | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  const range = report.range;
  const touches = report.touches;
  if (report.version !== 1 || (report.source !== 'raw' && report.source !== 'archive')
    || !timestamp(report.from) || !timestamp(report.sessionCloseAt) || report.from >= report.sessionCloseAt + 60_000
    || (report.firstAt !== null && !timestamp(report.firstAt)) || (report.lastAt !== null && !timestamp(report.lastAt))
    || !finite(report.sampleCount) || report.sampleCount < 0
    || !finite(report.expectedMinutes) || report.expectedMinutes < 0
    || !finite(report.missingMinutes) || report.missingMinutes < 0
    || (report.coverage !== 'complete' && report.coverage !== 'partial' && report.coverage !== 'missing')
    || !range || typeof range !== 'object' || !validNullableNumber((range as Record<string, unknown>).open)
    || !validNullableNumber((range as Record<string, unknown>).high)
    || !validNullableNumber((range as Record<string, unknown>).low)
    || !validNullableNumber((range as Record<string, unknown>).close)
    || !touches || typeof touches !== 'object'
    || !['sl', 'tgt1', 'tgt2'].every(key => (touches as Record<string, unknown>)[key] === null || normalizeTouch((touches as Record<string, unknown>)[key]) !== null)
    || (report.sequence !== 'sl-first' && report.sequence !== 'target-first' && report.sequence !== 'ambiguous' && report.sequence !== 'none-observed')) return null;

  const reportRange = range as Record<string, unknown>;
  const reportTouches = touches as Record<string, unknown>;
  const normalizedTouches = {
    sl: normalizeTouch(reportTouches.sl),
    tgt1: normalizeTouch(reportTouches.tgt1),
    tgt2: normalizeTouch(reportTouches.tgt2),
  };
  const from = report.from, until = report.sessionCloseAt + 60_000;
  if ((report.firstAt != null && (report.firstAt < from || report.firstAt >= until))
    || (report.lastAt != null && (report.lastAt < from || report.lastAt >= until))
    || Object.values(normalizedTouches).some(touch => touch && (touch.after < from || touch.at >= until))) return null;
  return {
    version: 1,
    source: report.source,
    from: report.from,
    sessionCloseAt: report.sessionCloseAt,
    firstAt: report.firstAt,
    lastAt: report.lastAt,
    sampleCount: report.sampleCount,
    expectedMinutes: report.expectedMinutes,
    missingMinutes: report.missingMinutes,
    coverage: report.coverage,
    range: {
      open: nullableNumber(reportRange.open),
      high: nullableNumber(reportRange.high),
      low: nullableNumber(reportRange.low),
      close: nullableNumber(reportRange.close),
    },
    touches: normalizedTouches,
    sequence: report.sequence,
    ...(report.futures === undefined ? {} : { futures: normalizeFuturesRange(report.futures, report.from, report.sessionCloseAt) }),
  };
}

export function highestObservedTarget(report: ObservationFollowThrough): 'tgt1' | 'tgt2' | null {
  if (report.touches.tgt2) return 'tgt2';
  if (report.touches.tgt1) return 'tgt1';
  return null;
}

export interface ObservationIdentity {
  id?: unknown;
  symbol?: unknown;
  date?: unknown;
  at?: unknown;
  reEntry?: number;
}

export function observationKey(card: ObservationIdentity): string | null {
  const suffix = card.reEntry ? `:re${card.reEntry}` : '';
  if (typeof card.symbol === 'string' && typeof card.date === 'string') return `${card.symbol}|${card.date}${suffix}`;
  return typeof card.id === 'string' && card.id.length ? `id:${card.id}` : null;
}

/** Preserve the newest-first occurrence and collapse repeat cards for one symbol/session. */
export function uniqueObservationCards<T extends ObservationIdentity>(cards: readonly T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((card, index) => {
    const key = observationKey(card) ?? `unkeyed:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sort newest-first while preserving source order for cards with equal timestamps. */
export function sortObservationCards<T extends ObservationIdentity>(cards: readonly T[]): T[] {
  return cards.map((card, index) => ({ card, index })).sort((left, right) => {
    const leftAt = typeof left.card.at === 'number' && Number.isFinite(left.card.at) ? left.card.at : Number.NEGATIVE_INFINITY;
    const rightAt = typeof right.card.at === 'number' && Number.isFinite(right.card.at) ? right.card.at : Number.NEGATIVE_INFINITY;
    return rightAt - leftAt || left.index - right.index;
  }).map(({ card }) => card);
}

export interface ObservationPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  start: number;
  end: number;
}

/** Slice an already ordered card list, clamping the requested page to its bounds. */
export type ObservationSignal = 'all' | 'early' | 'jev';
export type ObservationConfidence = 'all' | '65' | '80';

/**
 * Signal, confidence and free-text filters.
 *
 * `early` cards are code-computed and carry no model confidence, so a
 * confidence floor excludes them rather than pretending they scored 0%.
 * `query` matches symbol, contract (e.g. 128CE) and expiry, case-insensitive;
 * every whitespace-separated token must match.
 */
export function filterObservationCards<T extends ObservationIdentity & { early?: 'build-fast' | 'momentum' | null; quality?: number | null; strike?: number | null; side?: string | null; expiry?: string | null }>(
  cards: readonly T[],
  { signal = 'all', confidence = 'all', query = '' }: { signal?: ObservationSignal; confidence?: ObservationConfidence; query?: string } = {},
): T[] {
  const floor = confidence === 'all' ? null : Number(confidence) / 100;
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => {
    const isEarly = Boolean(card.early);
    if (signal === 'early' && !isEarly) return false;
    if (signal === 'jev' && isEarly) return false;
    if (floor != null) {
      const quality = Number(card.quality);
      if (!Number.isFinite(quality) || quality < floor) return false;
    }
    if (tokens.length) {
      const contract = typeof card.strike === 'number' && typeof card.side === 'string' ? `${card.strike}${card.side}` : '';
      const haystack = `${typeof card.symbol === 'string' ? card.symbol : ''} ${contract} ${typeof card.expiry === 'string' ? card.expiry : ''}`.toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) return false;
    }
    return true;
  });
}

export function paginateObservationCards<T>(cards: readonly T[], page: number, pageSize: number): ObservationPage<T> {
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 1;
  const total = cards.length;
  const totalPages = Math.ceil(total / size);
  const currentPage = totalPages === 0
    ? 1
    : Math.min(totalPages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  const offset = (currentPage - 1) * size;
  const items = cards.slice(offset, offset + size);
  return {
    items,
    page: currentPage,
    pageSize: size,
    total,
    totalPages,
    start: total ? offset + 1 : 0,
    end: total ? offset + items.length : 0,
  };
}
