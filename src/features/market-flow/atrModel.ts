export interface AtrCandle {
  at: number;
  close: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
}

export interface AtrSummary {
  atr: number;
  lastBarRange: number;
  state: 'compressed' | 'normal' | 'expanded';
}

export interface AtrSummaryOptions {
  period?: number;
  barMinutes?: number;
}

const MINUTE = 60_000;
const IST_OFFSET_MINUTES = 330;
const SESSION_OPEN_MINUTES = 9 * 60 + 15;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validTimestamp = (value: unknown): value is number => finite(value) && Number.isFinite(new Date(value).getTime());

function sessionAnchor(at: number): number {
  const shifted = new Date(at + IST_OFFSET_MINUTES * MINUTE);
  const utcMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return utcMidnight + (SESSION_OPEN_MINUTES - IST_OFFSET_MINUTES) * MINUTE;
}

function validWidth(barMinutes: number): boolean {
  return Number.isInteger(barMinutes) && barMinutes > 0 && Number.isFinite(barMinutes);
}

/** Group captured candles without filling gaps or manufacturing missing OHLC values. */
export function aggregateBars(candles: readonly AtrCandle[], barMinutes = 15): AtrCandle[] {
  if (!Array.isArray(candles) || !validWidth(barMinutes)) return [];

  const sorted = candles
    .filter(candle => candle != null && validTimestamp(candle.at) && finite(candle.close))
    .slice()
    .sort((a, b) => a.at - b.at);
  const bars = new Map<number, {
    at: number;
    first: AtrCandle;
    close: number;
    allRange: boolean;
    high: number;
    low: number;
  }>();
  const width = barMinutes * MINUTE;

  for (const candle of sorted) {
    const anchor = sessionAnchor(candle.at);
    const bucketAt = anchor + Math.floor((candle.at - anchor) / width) * width;
    const high = candle.high;
    const low = candle.low;
    const hasRange = finite(high) && finite(low) && high >= low;
    const current = bars.get(bucketAt);
    if (!current) {
      bars.set(bucketAt, {
        at: bucketAt,
        first: candle,
        close: candle.close,
        allRange: hasRange,
        high: hasRange ? high : Number.NaN,
        low: hasRange ? low : Number.NaN,
      });
      continue;
    }
    current.close = candle.close;
    if (!hasRange) {
      current.allRange = false;
    } else if (current.allRange) {
      current.high = Math.max(current.high, high);
      current.low = Math.min(current.low, low);
    }
  }

  return [...bars.values()].sort((a, b) => a.at - b.at).map(bar => ({
    at: bar.at,
    close: bar.close,
    open: finite(bar.first.open) ? bar.first.open : null,
    high: bar.allRange ? bar.high : null,
    low: bar.allRange ? bar.low : null,
  }));
}

/** Compute arithmetic ATR and classify the latest bar's range against it. */
export function atrSummary(candles: readonly AtrCandle[], options: AtrSummaryOptions = {}): AtrSummary | null {
  if (!Array.isArray(candles)) return null;
  const period = options?.period ?? 14;
  const barMinutes = options?.barMinutes ?? 15;
  if (!Number.isInteger(period) || period <= 0 || !Number.isFinite(period) || !validWidth(barMinutes)) return null;

  const bars = aggregateBars(candles, barMinutes);
  if (!bars.length) return null;
  const trueRanges: number[] = [];
  let previousClose: number | null = null;
  let lastBarRange: number | null = null;

  for (const bar of bars) {
    const high = bar.high;
    const low = bar.low;
    const fullRange = finite(high) && finite(low) && high >= low;
    let range: number | null = null;
    let trueRange: number | null = null;
    if (fullRange) {
      range = high - low;
      trueRange = previousClose == null
        ? range
        : Math.max(range, Math.abs(high - previousClose), Math.abs(low - previousClose));
    } else if (previousClose != null) {
      range = Math.abs(bar.close - previousClose);
      trueRange = range;
    }
    if (trueRange != null && finite(trueRange)) trueRanges.push(trueRange);
    lastBarRange = range != null && finite(range) ? range : null;
    previousClose = finite(bar.close) ? bar.close : null;
  }

  if (bars.length < period || trueRanges.length < period || lastBarRange == null) return null;
  const recent = trueRanges.slice(-period);
  const atr = recent.reduce((sum, value) => sum + value, 0) / period;
  if (!finite(atr) || !finite(lastBarRange)) return null;
  const state = atr === 0 || lastBarRange <= 0.7 * atr
    ? 'compressed'
    : lastBarRange >= 1.3 * atr
      ? 'expanded'
      : 'normal';
  return { atr, lastBarRange, state };
}
