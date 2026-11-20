import { describe, expect, it } from 'vitest';
import { bsPrice, premiumAtLevel, yearsToExpiry } from './optionMath.mjs';
import { selectWallTarget } from './wallTargets.mjs';

const at = Date.parse('2026-11-18T10:30:00+05:30');
const expiryDate = '2026-12-31';
const spot = 100;
const strike = 80;
const years = yearsToExpiry(expiryDate, at)!;
const entry = bsPrice({ spot, strike, years, iv: 0.3, side: 'CE' })!;
const stats = {
  instrument: 'EQ',
  holds: [2],
  entryTimes: ['10:30'],
  daily: {
    2: { recent: { up: { p30: 1, p50: 2, p70: 2.5, p85: 3, p95: 4, n: 500 }, down: { p30: 1, p50: 2, p70: 2.5, p85: 3, p95: 4, n: 500 } } },
  },
};
const context = (overrides: Record<string, unknown> = {}) => ({
  spot,
  entry,
  sl: entry - 0.1,
  expiryDate,
  holdDays: 2,
  decayPerDay: -0.12,
  moveStats: stats,
  walls: { support: { strike: 98, oi: 900 }, resistance: { strike: 101, oi: 2_000 } },
  gamma: { pin: '102CE', regime: 'gamma-long', flipLevel: 103 },
  contract: { strike, side: 'CE', iv: 30, at },
  ...overrides,
});

describe('selectWallTarget', () => {
  it('uses the bias-side OI wall and p85 cap, then prefers the passing wall with most OI', () => {
    const selected = selectWallTarget(context({
      walls: { support: { strike: 99, oi: 900_000 }, resistance: { strike: 102, oi: 50_000 } },
      gamma: { pin: '101CE', regime: 'gamma-long', flipLevel: 103 },
    }));
    expect(selected.basis).toBe('walls+decay');
    expect(selected.tgt1Wall).toEqual({ strike: 102, oi: 50_000, kind: 'resistance' });
    expect(selected.candidates.map(candidate => candidate.strike)).toEqual([101, 102]);
    expect(selected.candidates.find(candidate => candidate.strike === 101)?.kind).toBe('pin');
    expect(selected.candidates.every(candidate => candidate.reachPercentile != null)).toBe(true);
    expect(selected.p85MovePct).toBe(3);
  });

  it('includes the gamma flip only in gamma-short and deduplicates equal spot levels', () => {
    const short = selectWallTarget(context({
      walls: { resistance: { strike: 102, oi: 2_000 } },
      gamma: { pin: '101CE', regime: 'gamma-short', flipLevel: 102 },
    }));
    expect(short.candidates.map(candidate => candidate.kind)).toEqual(['pin', 'resistance']);
    expect(short.candidates[1].oi).toBe(2_000);

    const long = selectWallTarget(context({ gamma: { pin: null, regime: 'gamma-long', flipLevel: 101 } }));
    expect(long.candidates.map(candidate => candidate.kind)).toEqual(['resistance']);
  });

  it('selects a favorable-side support for puts and rejects walls beyond p85', () => {
    const putEntry = bsPrice({ spot, strike: 120, years, iv: 0.3, side: 'PE' })!;
    const selected = selectWallTarget(context({
      entry: putEntry,
      sl: putEntry - 0.1,
      walls: { support: { strike: 98, oi: 400 }, resistance: { strike: 101, oi: 900_000 } },
      gamma: { pin: '97PE', regime: 'gamma-long', flipLevel: 96 },
      contract: { strike: 120, side: 'PE', iv: 30, at },
    }));
    expect(selected.tgt1Wall).toMatchObject({ strike: 98, kind: 'support' });
    expect(selected.candidates.some(candidate => candidate.strike === 101)).toBe(false);

    const capped = selectWallTarget(context({
      walls: { resistance: { strike: 104, oi: 10_000 } },
      gamma: { pin: null, regime: 'gamma-long', flipLevel: null },
    }));
    expect(capped.basis).toBe('insufficient');
    expect(capped.candidates[0]).toMatchObject({ reject: 'beyond p85 favorable move', reachPercentile: 95 });
  });

  it('prices each wall at expiry-adjusted time and requires minimum reward:risk', () => {
    const selected = selectWallTarget(context());
    expect(selected.tgt1).toBe(premiumAtLevel({ level: 101, strike, years, iv: 0.3, side: 'CE', days: 2 }));
    expect(selected.rr).toBeGreaterThanOrEqual(2);

    const rejected = selectWallTarget(context({ minRR: 10_000 }));
    expect(rejected.basis).toBe('insufficient');
    expect(rejected.reject?.reason).toContain('reward:risk');
  });

  it('rejects a farther wall whose expiry-adjusted premium is consumed by decay', () => {
    const nearExpiry = '2026-11-19';
    const nearYears = yearsToExpiry(nearExpiry, at)!;
    const nearEntry = bsPrice({ spot, strike: 102, years: nearYears, iv: 0.3, side: 'CE' })!;
    const moveStats = {
      holds: [1],
      entryTimes: ['10:30'],
      daily: { 1: { recent: { up: { p30: 1, p50: 2, p70: 3, p85: 4, p95: 5, n: 500 }, down: { p30: 1, p50: 2, p70: 3, p85: 4, p95: 5, n: 500 } } } },
    };
    const result = selectWallTarget(context({
      entry: nearEntry,
      sl: nearEntry / 2,
      expiryDate: nearExpiry,
      holdDays: 1,
      moveStats,
      walls: { resistance: { strike: 101, oi: 10_000 } },
      gamma: null,
      contract: { strike: 102, side: 'CE', iv: 30, at },
    }));
    expect(result.basis).toBe('insufficient');
    expect(result.reject?.reason).toBe('decay leaves no positive premium target');
    expect(result.candidates[0]).toMatchObject({ strike: 101, reject: 'decay leaves no premium gain' });
  });

  it('chooses the next farther passing wall as TGT2 only when its R:R reaches 3', () => {
    const selected = selectWallTarget(context({
      walls: { resistance: { strike: 101, oi: 10_000 } },
      gamma: { pin: '102CE', regime: 'gamma-long', flipLevel: null },
    }));
    expect(selected.tgt1Wall).toMatchObject({ strike: 101 });
    expect(selected.tgt2Wall).toMatchObject({ strike: 102 });
    expect(selected.tgt2Rr).toBeGreaterThanOrEqual(3);
  });

  it('reports stored versus inverted IV source and fails closed with no p85 history', () => {
    expect(selectWallTarget(context()).ivSource).toBe('stored');
    const atmEntry = bsPrice({ spot, strike: spot, years, iv: 0.3, side: 'CE' })!;
    const inverted = selectWallTarget(context({
      entry: atmEntry,
      sl: atmEntry - 0.1,
      contract: { strike: spot, side: 'CE', iv: null, at },
    }));
    expect(inverted.ivSource).toBe('gamma-inverted');
    const missing = selectWallTarget(context({ moveStats: null }));
    expect(missing).toMatchObject({ basis: 'insufficient', reject: { reason: 'missing p85 favorable-move history' } });
    expect(missing.candidates.map(candidate => candidate.strike)).toEqual([101, 102]);
    expect(missing.candidates.every(candidate => candidate.reachPercentile === null && candidate.reject === 'missing p85 favorable-move history')).toBe(true);
    expect(selectWallTarget(context({ walls: {}, gamma: null }))).toMatchObject({ reject: { reason: 'no bias-side wall or gamma level' }, candidates: [] });
  });
});
