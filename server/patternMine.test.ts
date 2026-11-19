import { describe, expect, it } from 'vitest';
import { resample, barToken, rollingContext, wilsonLower, minePatterns, rankPatterns } from './patternMine.mjs';

const MINUTE = 60_000;
const OPEN = Date.parse('2026-11-18T09:15:00+05:30');
const bar = (n, { open, high, low, close, volume = 100, session = '2026.11.18' }) => ({
  at: OPEN + n * MINUTE, session, open, high, low, close, volume,
});

describe('resample', () => {
  it('aggregates 1-minute bars into anchored N-minute OHLC with summed volume', () => {
    const minutes = [
      bar(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      bar(1, { open: 100.5, high: 102, low: 100, close: 101.5 }),
      bar(2, { open: 101.5, high: 101.8, low: 98, close: 98.5 }),
      bar(3, { open: 98.5, high: 99.5, low: 98.2, close: 99 }),
      bar(4, { open: 99, high: 99.4, low: 98.8, close: 99.2 }),
      bar(5, { open: 99.2, high: 100, low: 99, close: 99.8 }),
    ];
    const five = resample(minutes, 5);
    expect(five).toHaveLength(2);
    expect(five[0]).toMatchObject({ open: 100, high: 102, low: 98, close: 99.2, volume: 500 });
    expect(five[1]).toMatchObject({ open: 99.2, close: 99.8, volume: 100 });
    expect(resample(minutes, 1)).toHaveLength(6);
    expect(resample([], 5)).toEqual([]);
  });
});

describe('barToken', () => {
  it('encodes direction, body size, close location and volume', () => {
    const strong = { open: 100, high: 104, low: 99.8, close: 103.8, volume: 400 };
    expect(barToken(strong, { atr: 1, avgVolume: 100 })).toBe('U3H2');
    const weak = { open: 100, high: 100.4, low: 99.6, close: 99.7, volume: 50 };
    expect(barToken(weak, { atr: 2, avgVolume: 100 })).toBe('D0L0');
    expect(barToken(strong, { atr: 1, avgVolume: 100, alphabet: 'dir' })).toBe('U');
    expect(barToken(strong, { atr: 1, avgVolume: 100, alphabet: 'body' })).toBe('U3');
    expect(barToken(strong, { atr: 1, avgVolume: 100, alphabet: 'shape' })).toBe('U3H');
  });

  it('rolls ATR and average volume without looking ahead', () => {
    const bars = [0, 1, 2, 3].map(n => bar(n, { open: 100, high: 102, low: 99, close: 101, volume: 100 }));
    const { atr, avgVolume } = rollingContext(bars, 3);
    expect(atr[0]).toBeNull();
    expect(atr[2]).toBeGreaterThan(0);
    expect(avgVolume[2]).toBe(100);
  });
});

describe('wilsonLower', () => {
  it('punishes small samples', () => {
    expect(wilsonLower(10, 10)).toBeGreaterThan(0.7);
    expect(wilsonLower(1000, 1000)).toBeGreaterThan(0.99);
    expect(wilsonLower(1, 1)).toBeLessThan(0.5);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('minePatterns / rankPatterns', () => {
  // Every third bar is followed by a 2% rally, so "D D" must predict UP.
  const bars = [];
  for (let i = 0; i < 60; i++) {
    const rally = i % 3 === 2;
    bars.push(bar(i, { open: 100, high: rally ? 100.5 : 100.5, low: 99.5, close: rally ? 100 : 99.8 }));
    if (rally) bars.push(bar(i + 0.5, { open: 100, high: 102.5, low: 100, close: 102.4 }));
  }

  it('counts what followed a sequence and never crosses sessions', () => {
    const result = minePatterns(bars, { lookback: 2, horizon: 1, targetPct: 1, period: 3, alphabet: 'dir' });
    expect(result.base.train.n).toBeGreaterThan(0);
    const ranked = rankPatterns(result, { minSamples: 3 });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].hitRate).toBeGreaterThan(0);
    expect(ranked[0].floor).toBeLessThanOrEqual(ranked[0].hitRate);

    // A session boundary inside the horizon removes the sample entirely.
    const split = bars.map((item, i) => ({ ...item, session: i > 30 ? '2026.11.19' : '2026.11.18' }));
    const guarded = minePatterns(split, { lookback: 2, horizon: 3, targetPct: 1, period: 3, alphabet: 'dir' });
    expect(guarded.base.train.n).toBeLessThan(minePatterns(bars, { lookback: 2, horizon: 3, targetPct: 1, period: 3, alphabet: 'dir' }).base.train.n);
  });

  it('splits learn and check periods by session date', () => {
    const dated = bars.map((item, i) => ({ ...item, session: i < 30 ? '2023.06.01' : '2024.06.01' }));
    const result = minePatterns(dated, { lookback: 2, horizon: 1, targetPct: 1, period: 3, alphabet: 'dir', splitAt: '2024.01.01' });
    expect(result.base.train.n).toBeGreaterThan(0);
    expect(result.base.test.n).toBeGreaterThan(0);
  });
});