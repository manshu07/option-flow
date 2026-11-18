import { describe, expect, it } from 'vitest';
import { flipCrosses, forwardReturns, evaluateCrosses, summarize, summaryLines } from './gammaValidation.mjs';

const SESSION = '2026-11-18';
const OPEN = Date.parse(`${SESSION}T09:15:00+05:30`);
const minute = n => OPEN + n * 60_000;

describe('flipCrosses', () => {
  it('detects one cross per side change and ignores spot printing at the level', () => {
    const samples = [
      { at: minute(0), spot: 100, flip: 101 },
      { at: minute(5), spot: 100.5, flip: 101 },
      { at: minute(10), spot: 101.4, flip: 101 }, // cross up
      { at: minute(15), spot: 101.8, flip: 101 }, // still above
      { at: minute(20), spot: 100.6, flip: 101 }, // cross down
      { at: minute(25), spot: 101.2, flip: null }, // flip unknown — ignored
    ];
    const crosses = flipCrosses(samples);
    expect(crosses.map(cross => cross.direction)).toEqual(['up', 'down']);
    expect(crosses[0]).toMatchObject({ spot: 101.4, flip: 101 });
    expect(crosses[0].movePct).toBeCloseTo(0.896, 2);
  });

  it('can require a minimum move at the crossing', () => {
    const samples = [
      { at: minute(0), spot: 100, flip: 101 },
      { at: minute(5), spot: 101.05, flip: 101 },
    ];
    expect(flipCrosses(samples, { minMovePct: 2 })).toHaveLength(0);
    expect(flipCrosses(samples)).toHaveLength(1);
  });
});

describe('forwardReturns', () => {
  const points = [0, 15, 30, 60, 120].map(n => ({ at: minute(n), close: 100 + n * 0.1 }));
  it('measures the move at each horizon and at the session close', () => {
    const returns = forwardReturns(points, minute(0), 100);
    expect(returns.m15).toBeCloseTo(1.5, 6);
    expect(returns.m30).toBeCloseTo(3, 6);
    expect(returns.m60).toBeCloseTo(6, 6);
    expect(returns.eod).toBeCloseTo(12, 6);
  });

  it('returns null rather than guessing when the horizon is not captured', () => {
    const returns = forwardReturns(points.slice(0, 2), minute(0), 100);
    expect(returns.m15).toBeCloseTo(1.5, 6);
    expect(returns.m30).toBeNull();
    expect(returns.m60).toBeNull();
  });
});

describe('evaluateCrosses / summarize', () => {
  const points = [0, 60, 120].map(n => ({ at: minute(n), close: n === 0 ? 100 : 102.2 }));

  it('scores a cross that kept going in its direction, and one that did not', () => {
    const followed = evaluateCrosses({
      symbol: 'ITC',
      samples: [{ at: minute(0), spot: 99.2, flip: 99.5 }, { at: minute(5), spot: 100.9, flip: 99.8 }],
      points,
    });
    expect(followed).toHaveLength(1);
    expect(followed[0].direction).toBe('up');
    expect(followed[0].followed).toBe(true);
    expect(followed[0].matchPct).toBeGreaterThan(0.3);

    const failed = evaluateCrosses({
      symbol: 'SAIL',
      samples: [{ at: minute(0), spot: 100.6, flip: 99.5 }, { at: minute(5), spot: 99.2, flip: 99.8 }],
      points,
    });
    expect(failed[0].direction).toBe('down');
    // spot went UP after a downside cross → the move did not follow
    expect(failed[0].matchPct).toBeLessThan(0);
    expect(failed[0].followed).toBe(false);
  });

  it('aggregates a hit rate and keeps directional splits', () => {
    const records = [
      { direction: 'up', matchPct: 0.8, followed: true },
      { direction: 'up', matchPct: -0.2, followed: false },
      { direction: 'down', matchPct: 0.5, followed: true },
      { direction: 'down', matchPct: null, followed: false }, // no futures coverage — not evaluated
    ];
    const summary = summarize(records);
    expect(summary).toMatchObject({ crosses: 4, evaluated: 3, followed: 2 });
    expect(summary.hitRate).toBeCloseTo(2 / 3, 6);
    expect(summary.up).toMatchObject({ crosses: 2, followed: 1 });
    expect(summary.down).toMatchObject({ crosses: 1, followed: 1 });

    const lines = summaryLines(summary, { from: SESSION, to: SESSION, symbols: 'ITC,SAIL' });
    expect(lines[0]).toContain('Gamma flip validation');
    expect(lines[2]).toContain('67%');
  });

  it('says so when nothing could be evaluated', () => {
    const lines = summaryLines(summarize([]), { from: SESSION, to: SESSION, symbols: 'ITC' });
    expect(lines.join('\n')).toContain('No cross could be evaluated');
  });
});