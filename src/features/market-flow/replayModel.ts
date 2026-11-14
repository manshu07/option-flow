import type { FuturesSeries } from '../options-scanner/futuresModel';
import { sourceForDay, type ReplayDay } from './feed';
import { marketSessionBounds } from '@/lib/marketSession';

const MINUTE = 60_000;

/** A futures candle can affect a replay only after its one-minute interval has closed. */
export function sliceFuturesSeries(series: FuturesSeries, cursorMs: number): FuturesSeries {
  return {
    ...series,
    candles: series.candles.filter(candle => candle.at + MINUTE <= cursorMs),
  };
}

/** Keep a small LRU-like window of whole-market snapshots for replay seeks. */
export function rememberMarketMinute<T>(cache: ReadonlyMap<string, T>, minute: string, value: T, limit = 40): Map<string, T> {
  const next = new Map(cache);
  next.delete(minute);
  next.set(minute, value);
  while (next.size > Math.max(1, limit)) next.delete(next.keys().next().value!);
  return next;
}

export const REPLAY_CACHE_LIMIT = 40;

export function isReplayableDay(day: Pick<ReplayDay, 'minutes' | 'firstAt' | 'lastAt'>): boolean {
  return day.minutes > 0 && day.firstAt != null && day.lastAt != null;
}

export function isSelectableReplayDay(day: ReplayDay): boolean {
  return isReplayableDay(day) && sourceForDay(day) != null;
}

export type ReplaySpeed = 0.5 | 1 | 2 | 5;

export function playbackIntervalMs(speed: ReplaySpeed): number {
  return speed === 0.5 ? 1400 : speed === 2 ? 350 : speed === 5 ? 140 : 700;
}

const SPEED_KEY = 'order-flow.replay-speed';
export function loadPlaybackSpeed(): ReplaySpeed {
  if (typeof localStorage === 'undefined') return 1;
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return value === 0.5 || value === 1 || value === 2 || value === 5 ? value : 1;
  } catch { return 1; }
}
export function savePlaybackSpeed(speed: ReplaySpeed): void {
  try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* storage is optional */ }
}

export type ReplayWindow = 'full' | 'morning' | 'afternoon' | 'last-hour' | 'custom';
export interface ReplayWindowSpec {
  window: ReplayWindow;
  start?: string;
  end?: string;
}

const minuteOf = (value: string) => {
  const match = /^(\d{2})(\d{2})$/.exec(value.replace(':', ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const epochAtMinute = (date: string, minute: number) => Date.parse(`${date}T00:00:00+05:30`) + minute * MINUTE;

/** Clips captured minutes using the exchange's date-aware open and close. */
export function replayWindowBounds(date: string, spec: ReplayWindowSpec): { start: number; end: number } {
  const { open, close } = marketSessionBounds(epochAtMinute(date, 0));
  if (spec.window === 'morning') return { start: open, end: Math.min(close, open + 195 * MINUTE) };
  if (spec.window === 'afternoon') return { start: Math.min(close, epochAtMinute(date, 12 * 60 + 30)), end: close };
  if (spec.window === 'last-hour') return { start: Math.max(open, close - 60 * MINUTE), end: close };
  if (spec.window === 'custom') {
    const start = minuteOf(spec.start ?? '') ?? 9 * 60 + 15;
    const end = minuteOf(spec.end ?? '') ?? 15 * 60 + 40;
    const clippedStart = Math.max(open, epochAtMinute(date, start));
    const clippedEnd = Math.min(close, epochAtMinute(date, end));
    return clippedEnd >= clippedStart
      ? { start: clippedStart, end: clippedEnd }
      : { start: clippedEnd, end: clippedStart };
  }
  return { start: open, end: close };
}

export function clipReplayMinutes(date: string, minutes: Array<[string, number]>, spec: ReplayWindowSpec): Array<[string, number]> {
  const bounds = replayWindowBounds(date, spec);
  return minutes.filter(([, at]) => at >= bounds.start && at <= bounds.end);
}

export interface ReplayModeState {
  mode: 'live' | 'replay';
  playing: boolean;
  cursorIndex: number;
}

/** Advances through captured minutes only, stopping rather than wrapping at the end. */
export function advanceReplay(state: ReplayModeState, lastIndex: number): ReplayModeState {
  if (state.mode !== 'replay' || !state.playing || state.cursorIndex >= lastIndex) {
    return state.cursorIndex >= lastIndex && state.playing ? { ...state, playing: false } : state;
  }
  return { ...state, cursorIndex: state.cursorIndex + 1 };
}

export function replayRange(start: number | null, end: number | null, format: (value: number) => string): string {
  if (start == null || end == null) return 'No captured minutes';
  return `${format(start)}–${format(end)}`;
}

/** Replay only the minutes the current board's day model can represent. */
export function boardReplayMinutes(date: string, minutes: Array<[string, number]>): Array<[string, number]> {
  const { open, close } = marketSessionBounds(Date.parse(`${date}T00:00:00+05:30`));
  return minutes.filter(([, at]) => at >= open && at <= close);
}
