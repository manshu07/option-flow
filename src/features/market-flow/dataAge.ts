import { getLatestTradingSessionDate, marketParts } from '@/lib/marketSession';

/**
 * How old the board's market reading is, in words the page can print.
 *
 * `aged` is true when the reading is not from the latest trading session: the
 * page then says so beside the time, rather than letting an old board pass for
 * today's. A reading from the latest session is never aged, even after the
 * close: the board then describes that session's end.
 */
export interface FlowDataAge {
  aged: boolean;
  /** The session date of the reading, YYYY-MM-DD in IST. */
  date: string;
}

export function describeDataAge(readingAt: number, now: number = Date.now()): FlowDataAge {
  const date = marketParts(readingAt).dateKey;
  return { aged: date < getLatestTradingSessionDate(new Date(now)), date };
}

/**
 * How far behind the clock the board's reading is, for the status line.
 *
 * A visible tab should never sit on a two-minute-old file: the market file is
 * rebuilt every minute, so anything past `STALE_MINUTES` means the page's own
 * polling stalled (a backgrounded tab, a failed fetch) and the owner would be
 * reading old numbers without knowing it.
 */
export const STALE_MINUTES = 3;

export function describeStale(readingAt: number, now: number = Date.now()): { stale: boolean; minutes: number | null } {
  if (!Number.isFinite(readingAt) || !Number.isFinite(now)) return { stale: false, minutes: null };
  const minutes = Math.max(0, Math.round((now - readingAt) / 60_000));
  return { stale: minutes >= STALE_MINUTES, minutes };
}
