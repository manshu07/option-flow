import { describe, expect, it } from 'vitest';
import { candlesFromCloses, compressedScale, compressedTicks, drawnValues, gateRows, sCurve, sCurveOn } from './diagramModel';

const MIN = 60_000;

describe('the flow diagram', () => {
  it('compresses the change scale symmetrically, holds nought at the middle and the reach at the edge', () => {
    const y = compressedScale(8, 400, 300);
    expect(y(0)).toBe(400);
    expect(y(8)).toBeCloseTo(100, 6);
    expect(y(-8)).toBeCloseTo(700, 6);
    expect(y(20)).toBeCloseTo(100, 6);
    // The crowd near nought gets more room than a linear scale gives it.
    expect(400 - y(1)).toBeGreaterThan(300 / 8 * 2);
    expect(y(1)).toBeLessThan(y(0.5));
  });

  it('ticks from a fixed ladder, kept apart', () => {
    const ticks = compressedTicks(8, 300);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(8);
    expect(ticks).toContain(1);
    const y = compressedScale(8, 0, 300);
    for (let i = 1; i < ticks.length; i++) expect(y(ticks[i - 1]) - y(ticks[i])).toBeGreaterThanOrEqual(22);
  });

  it('squeezes each side into a short tunnel: up from the top in rank order, flat on the zero line, the largest down move at the bottom', () => {
    const { rows, upEnd, downStart, flatTop, flatBottom } = gateRows(['A', 'B'], ['F'], ['X', 'Y'], 0, 1000);
    // Few names: three pixels apart, nowhere near the cap.
    expect(rows.get('A')).toBe(1.5);
    expect(rows.get('B')).toBe(4.5);
    expect(upEnd).toBe(6);
    expect(rows.get('F')).toBe(500);
    expect([flatTop, flatBottom]).toEqual([498.5, 501.5]);
    expect(rows.get('X')).toBe(998.5);
    expect(rows.get('Y')).toBe(995.5);
    expect(downStart).toBe(994);
  });

  it('caps a crowded tunnel at its share of the height', () => {
    const many = Array.from({ length: 200 }, (_, i) => `S${i}`);
    const { rows, upEnd, downStart } = gateRows(many, [], many.map(s => `${s}d`), 0, 1000);
    expect(upEnd).toBe(100);
    expect(downStart).toBe(900);
    expect(rows.get('S0')).toBeCloseTo(0.25);
    expect(rows.get('S199d')).toBeCloseTo(900.25);
  });

  it('draws level-ended S-curves, also as a continuation', () => {
    expect(sCurve(0, 0, 100, 50)).toBe('M0.0,0.0C50.0,0.0 50.0,50.0 100.0,50.0');
    expect(sCurveOn(0, 0, 100, 50)).toBe('C50.0,0.0 50.0,50.0 100.0,50.0');
  });

  it('builds candles from the minute closes', () => {
    const t = Date.parse('2026-10-09T09:15:00+05:30');
    const closes = [10, 12, 9, 11, 11.5, 13, 12].map((close, i) => ({ at: t + i * MIN, close, oi: 1 }));
    const bars = candlesFromCloses(closes, 5);
    expect(bars).toEqual([
      { at: t, open: 10, high: 12, low: 9, close: 11.5 },
      { at: t + 5 * MIN, open: 13, high: 13, low: 12, close: 12 },
    ]);
  });

  it('aligns buckets to the session clock when the first minute starts mid-bucket', () => {
    const t = Date.parse('2026-10-09T09:17:00+05:30');
    const closes = [10, 11, 12, 13, 14].map((close, i) => ({ at: t + i * MIN, close, oi: 1 }));
    const bars = candlesFromCloses(closes, 5);
    expect(bars).toEqual([
      { at: Date.parse('2026-10-09T09:15:00+05:30'), open: 10, high: 12, low: 10, close: 12 },
      { at: Date.parse('2026-10-09T09:20:00+05:30'), open: 13, high: 14, low: 13, close: 14 },
    ]);
  });

  it('never merges two days into one bucket', () => {
    const friday = Date.parse('2026-10-09T15:29:00+05:30');
    const monday = Date.parse('2026-10-12T09:15:00+05:30');
    const bars = candlesFromCloses([{ at: friday, close: 100, oi: 1 }, { at: monday, close: 101, oi: 1 }], 15);
    expect(bars).toEqual([
      { at: Date.parse('2026-10-09T15:15:00+05:30'), open: 100, high: 100, low: 100, close: 100 },
      { at: monday, open: 101, high: 101, low: 101, close: 101 },
    ]);
  });

  it('nests every timeframe on the same session edges', () => {
    const t = Date.parse('2026-10-09T09:15:00+05:30');
    const closes = Array.from({ length: 30 }, (_, i) => ({ at: t + i * MIN, close: 10 + i, oi: 1 }));
    const five = candlesFromCloses(closes, 5);
    const fifteen = candlesFromCloses(closes, 15);
    expect(five.map(bar => bar.at)).toEqual([0, 5, 10, 15, 20, 25].map(m => t + m * MIN));
    expect(five[0]).toMatchObject({ open: 10, close: 14 });
    expect(fifteen.map(bar => bar.at)).toEqual([t, t + 15 * MIN]);
    expect(fifteen[0]).toMatchObject({ open: 10, close: 24 });
    // Every 5-minute bar sits inside one 15-minute bar.
    for (const bar of five) {
      const holder = fifteen.find(edge => bar.at >= edge.at && bar.at < edge.at + 15 * MIN);
      expect(holder).toBeDefined();
    }
  });

});

describe('the drawn line', () => {
  it('drops a single-minute spike that reverts, keeps a move that holds, and leaves the reported change alone', () => {
    const flat: number[] = Array.from({ length: 30 }, (_, i) => (i === 0 ? 0 : 1));
    const spiked = flat.slice();
    spiked[10] = 6; // a bad print: +5% for one minute
    const drawn = drawnValues(spiked);
    expect(Math.max(...drawn)).toBeLessThan(1.05);
    // A step that holds is followed.
    const step = Array.from({ length: 40 }, (_, i) => (i === 0 ? 0 : i < 15 ? 0.5 : 3.5));
    expect(drawnValues(step).at(-1)).toBeGreaterThan(3.4);
    // It starts at nought and leaves it as a curve, not a cliff.
    const gap = Array.from({ length: 20 }, (_, i) => (i === 0 ? 0 : 5));
    const d = drawnValues(gap);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeLessThan(2);
    expect(d.at(-1)).toBeGreaterThan(4.9);
    expect(spiked[10]).toBe(6);
  });
});
