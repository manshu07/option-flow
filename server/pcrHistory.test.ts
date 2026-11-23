import { describe, expect, it } from 'vitest';
import { createPcrHistory, pcrForNearSeries, pcrSnapshot } from './pcrHistory.mjs';

const series = (symbol: string, rows: unknown[][]) => ({ s: symbol, r: rows });

describe('session PCR history', () => {
  it('builds one API row per captured series with current near PCR and the injected 15-minute shift', () => {
    const at = 12_345;
    const rows = pcrSnapshot([
      series('NIFTY', [[25_000, 0, 1, 1, 100, null], [25_000, 1, 1, 1, 87, null]]),
      series('EMPTY', [[1, 0, 1, 1, 0, null]]),
    ], at, symbol => symbol === 'NIFTY' ? -4.2 : null);
    expect(rows).toEqual([
      { symbol: 'NIFTY', pcr: 0.87, pcrShift15m: -4.2, ts: at },
      { symbol: 'EMPTY', pcr: null, pcrShift15m: null, ts: at },
    ]);
  });

  it('uses near rows rather than next-expiry rows for the card PCR context', () => {
    const near = series('NIFTY', [[25_000, 0, 1, 1, 200, null], [25_000, 1, 1, 1, 100, null]]) as { s: string; r: unknown[][]; next?: unknown };
    near.next = { e: '2026-12-31', r: [[25_000, 0, 1, 1, 1, null], [25_000, 1, 1, 1, 9, null]] };
    expect(pcrForNearSeries(near)).toBe(0.5);
  });

  it('calculates put/call OI from near rows and skips zero, negative, invalid, and unknown-side OI', () => {
    const history = createPcrHistory();
    history.resetForSession('2026-11-20');
    history.record([
      series('NIFTY', [
        [25_000, 0, 1, 1, 100, null],
        [25_000, 1, 1, 1, 150, null],
        [25_100, 0, 1, 1, 0, null],
        [25_100, 1, 1, 1, -50, null],
        [25_200, 0, 1, 1, Number.NaN, null],
        [25_200, 2, 1, 1, 900, null],
      ]),
      // No positive call OI means there is no defined ratio to record.
      series('EMPTY', [[100, 1, 1, 1, 100, null], [100, 0, 1, 1, 0, null]]),
    ], 1_000);

    expect(history.pointsFor('NIFTY')).toEqual([{ t: 1_000, pcr: 1.5 }]);
    expect(history.pointsFor('EMPTY')).toEqual([]);
  });

  it('returns the percent change between the latest points at/before the 15-minute anchors', () => {
    const history = createPcrHistory();
    history.resetForSession('2026-11-20');
    const minute = 60_000;
    const sample = (t: number, pcr: number) => history.record([
      series('BANKNIFTY', [[50_000, 0, 1, 1, 100, null], [50_000, 1, 1, 1, 100 * pcr, null]]),
    ], t);
    sample(0, 1);
    sample(14 * minute, 1.1);
    sample(16 * minute, 1.2);

    expect(history.shiftFor('BANKNIFTY', 16 * minute)).toBe(20);
    expect(history.shiftFor('UNKNOWN', 16 * minute)).toBeNull();
    expect(history.shiftFor('BANKNIFTY', 14 * minute)).toBeNull();
    expect(history.shiftFor('BANKNIFTY', 30 * minute)).toBeCloseTo(9.09, 2);
  });

  it('caps each symbol at 100 points, replaces same-time builds, and resets on a new session', () => {
    const history = createPcrHistory();
    const sample = (t: number, pcr: number) => history.record([
      series('SENSEX', [[80_000, 0, 1, 1, 100, null], [80_000, 1, 1, 1, 100 * pcr, null]]),
    ], t);
    history.resetForSession('2026-11-20');
    for (let minute = 0; minute <= 100; minute++) sample(minute * 60_000, 1 + minute / 100);
    sample(100 * 60_000, 2);

    const points = history.pointsFor('SENSEX');
    expect(points).toHaveLength(100);
    expect(points[0].t).toBe(60_000);
    expect(points.at(-1)).toEqual({ t: 100 * 60_000, pcr: 2 });
    expect(history.shiftFor('SENSEX', 100 * 60_000)).not.toBeNull();

    history.resetForSession('2026-11-23');
    expect(history.pointsFor('SENSEX')).toEqual([]);
    expect(history.shiftFor('SENSEX', 100 * 60_000)).toBeNull();
  });

  it('does not return a shift without distinct bracketing samples or a positive starting PCR', () => {
    const history = createPcrHistory();
    history.resetForSession('2026-11-20');
    history.record([series('ZERO', [[100, 0, 1, 1, 10, null]])], 0);
    history.record([series('ZERO', [[100, 1, 1, 1, 0, null], [100, 0, 1, 1, 10, null]])], 15 * 60_000);
    expect(history.shiftFor('ZERO', 15 * 60_000)).toBeNull();
  });
});
