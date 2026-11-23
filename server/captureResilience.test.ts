import { describe, expect, it } from 'vitest';
import {
  mergeDhanFuturesCandle,
  parseTodayIntraday,
  shouldBackfillToday,
  shouldRunTodayBackfill,
} from './providers/dhan.mjs';

const SESSION = '2026-11-20';
const minute = (hour: number, min: number) => Date.parse(`${SESSION}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+05:30`);

describe('capture resilience helpers', () => {
  it('field-merges REST and feed candles without losing extrema; feed close/OI win', () => {
    expect(mergeDhanFuturesCandle(
      { at: 1, open: 100, high: 110, low: 95, close: 103, oi: 100, volume: 10 },
      { at: 1, open: 102, high: 108, low: 90, close: 105, oi: 120, volume: 15 },
    )).toEqual({ at: 1, open: 100, high: 110, low: 90, close: 105, oi: 120, volume: 15 });
  });

  it('requests today REST only for sparse stale in-session futures, not fresh or out-of-session data', () => {
    const now = minute(11, 0);
    const sparseStale = Array.from({ length: 10 }, (_, i) => ({ at: minute(9, 15 + i), close: 100, oi: 10 }));
    const sufficientStale = Array.from({ length: 30 }, (_, i) => ({ at: minute(9, 15 + i), close: 100, oi: 10 }));
    const sparseFresh = [{ at: now - 30_000, close: 100, oi: 10 }];
    expect(shouldBackfillToday(sparseStale, now, SESSION)).toBe(true);
    expect(shouldBackfillToday(sufficientStale, now, SESSION)).toBe(false);
    expect(shouldBackfillToday(sparseFresh, now, SESSION)).toBe(false);
    expect(shouldBackfillToday(sparseStale, now, '2026-11-19')).toBe(false);
    expect(shouldBackfillToday(sparseStale, minute(18, 0), SESSION)).toBe(false);
  });

  it('keeps the backfill session guard separate from force/staleness selection', () => {
    expect(shouldRunTodayBackfill(minute(11, 0), SESSION)).toBe(true);
    expect(shouldRunTodayBackfill(minute(18, 0), SESSION)).toBe(false);
    expect(shouldRunTodayBackfill(minute(11, 0), SESSION, { postClose: true })).toBe(false);
    expect(shouldRunTodayBackfill(minute(18, 0), SESSION, { postClose: true })).toBe(true);
    expect(shouldRunTodayBackfill(minute(18, 0), '2026-11-19', { postClose: true })).toBe(false);
  });

  it('normalizes one-day intraday responses and excludes other dates or invalid rows', () => {
    const rows = parseTodayIntraday({
      timestamp: [minute(9, 15) / 1000, minute(9, 16) / 1000, minute(9, 17) / 1000, minute(9, 18) / 1000],
      open: [100, 101, 102, 103], high: [102, 103, 104, 104], low: [99, 100, 101, 102],
      close: [101, 102, null, 103], open_interest: [10, 11, 12, -1], volume: [1, 2, 3, 4],
    }, SESSION);
    expect(rows).toEqual([
      { at: minute(9, 15), open: 100, high: 102, low: 99, close: 101, oi: 10, volume: 1 },
      { at: minute(9, 16), open: 101, high: 103, low: 100, close: 102, oi: 11, volume: 2 },
    ]);
  });

});
