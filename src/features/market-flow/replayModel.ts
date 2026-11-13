import type { FuturesSeries } from '../options-scanner/futuresModel';
import { sessionEndOf } from './marketFlowModel';

const MINUTE = 60_000;

/** A futures candle can affect a replay only after its one-minute interval has closed. */
export function sliceFuturesSeries(series: FuturesSeries, cursorMs: number): FuturesSeries {
  return {
    ...series,
    candles: series.candles.filter(candle => candle.at + MINUTE <= cursorMs),
  };
}

/** Keep a small LRU-like window of whole-market snapshots for replay seeks. */
export function rememberMarketMinute<T>(cache: ReadonlyMap<string, T>, minute: string, value: T, limit = 3): Map<string, T> {
  const next = new Map(cache);
  next.delete(minute);
  next.set(minute, value);
  while (next.size > Math.max(1, limit)) next.delete(next.keys().next().value!);
  return next;
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
  const open = Date.parse(`${date}T09:15:00+05:30`);
  const close = sessionEndOf(date);
  return minutes.filter(([, at]) => at >= open && at <= close);
}
