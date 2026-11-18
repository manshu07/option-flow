import { describe, expect, it } from 'vitest';
import { combineMonths } from './futuresModel';

describe('combineMonths OHLC preservation', () => {
  it('preserves only near-month OHLC and keeps close-only output shape otherwise', () => {
    expect(combineMonths('NIFTY', [
      { date: '2026-11-19', prevClose: 100, prevOi: 10, candles: [{ at: 1, close: 101, oi: 11, open: 100, high: 103, low: 99 }] },
      { date: '2026-12-24', prevClose: 102, prevOi: 20, candles: [{ at: 1, close: 102, oi: 22, open: 101, high: 105, low: 98 }] },
    ])).toEqual({
      symbol: 'NIFTY', contractDate: '2026-11-19', months: ['2026-11-19', '2026-12-24'], prevClose: 100, prevOi: 30,
      candles: [{ at: 1, close: 101, oi: 33, open: 100, high: 103, low: 99 }],
    });
    expect(combineMonths('NIFTY', [{ date: '2026-11-19', prevClose: 100, prevOi: 10, candles: [{ at: 1, close: 101, oi: 11 }] }])?.candles).toEqual([{ at: 1, close: 101, oi: 11 }]);
  });
});
