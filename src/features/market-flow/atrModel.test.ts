import { describe, expect, it } from 'vitest';
import { aggregateBars, atrSummary, type AtrCandle } from './atrModel';

const MINUTE = 60_000;
const at = (hour: number, minute: number, day = 13) => Date.parse(`2026-11-${String(day).padStart(2, '0')}T09:15:00+05:30`) + ((hour * 60 + minute) - (9 * 60 + 15)) * MINUTE;
const candle = (timestamp: number, close: number, high = close + 2, low = close - 2): AtrCandle => ({ at: timestamp, open: close - 1, high, low, close });

describe('ATR range model', () => {
  it('anchors 15-minute buckets at 09:15 IST, keeps dates separate, and leaves gaps empty', () => {
    const candles = [
      candle(at(9, 15), 101), candle(at(9, 29), 103), candle(at(9, 30), 105),
      candle(at(9, 45), 107), candle(at(9, 15, 14), 201),
    ];
    expect(aggregateBars(candles)).toEqual([
      { at: at(9, 15), close: 103, open: 100, high: 105, low: 99 },
      { at: at(9, 30), close: 105, open: 104, high: 107, low: 103 },
      { at: at(9, 45), close: 107, open: 106, high: 109, low: 105 },
      { at: at(9, 15, 14), close: 201, open: 200, high: 203, low: 199 },
    ]);
  });

  it('does not mutate input and keeps mixed OHLC bars on the close-only fallback', () => {
    const candles = [candle(at(9, 15), 100), { at: at(9, 16), close: 104, high: null, low: null }];
    const original = candles.slice();
    expect(aggregateBars(candles)).toEqual([{ at: at(9, 15), close: 104, open: 99, high: null, low: null }]);
    expect(candles).toEqual(original);
  });

  it('uses full true range, close-only gaps, and requires fourteen valid TRs', () => {
    const full: AtrCandle[] = Array.from({ length: 15 }, (_, index) => candle(at(9, 15 + index * 15), 100 + index, 102 + index, 98 + index));
    expect(atrSummary(full)).toEqual({ atr: 4, lastBarRange: 4, state: 'normal' });
    const closeOnly = Array.from({ length: 14 }, (_, index) => ({ at: at(9, 15 + index * 15), close: 100 + index }));
    expect(atrSummary(closeOnly)).toBeNull();
    expect(atrSummary([{ at: at(9, 0), close: 100 }, ...closeOnly])).not.toBeNull();
  });

  it('classifies thresholds and flat zero-ATR data without NaN', () => {
    const base = Array.from({ length: 14 }, (_, index) => candle(at(9, 15 + index * 15), 100 + index));
    expect(atrSummary([...base.slice(0, 13), { at: at(12, 30), close: 110, high: 120, low: 100 }])).toEqual({ atr: expect.any(Number), lastBarRange: 20, state: 'expanded' });
    const flat = Array.from({ length: 14 }, (_, index) => candle(at(9, 15 + index * 15), 100, 100, 100));
    expect(atrSummary(flat)).toEqual({ atr: 0, lastBarRange: 0, state: 'compressed' });
    expect(atrSummary(flat, { period: 0 })).toBeNull();
    expect(atrSummary(flat, { barMinutes: 0 })).toBeNull();
  });
});
