import { describe, expect, it } from 'vitest';
import { yearsToExpiry, greeks, optionIv, premiumForMove, requiredMove, levelFor } from './optionMath.mjs';

const NOW = Date.parse('2026-11-18T15:30:00+05:30');

describe('yearsToExpiry', () => {
  it('measures to the expiry close and never returns zero', () => {
    expect(yearsToExpiry('2026-11-23', NOW)).toBeCloseTo(5 / 365, 6);
    expect(yearsToExpiry('2026-12-29', NOW)).toBeCloseTo(41 / 365, 6);
    expect(yearsToExpiry('2026-11-18', NOW)).toBeGreaterThan(0);
    expect(yearsToExpiry('nonsense', NOW)).toBeNull();
  });
});

describe('greeks', () => {
  // The live IREDA 120CE reading of 2026-11-18 15:30: spot 119.8, premium 2.53, IV 40.4%.
  const input = { spot: 119.8, strike: 120, years: 5 / 365, iv: 0.404, side: 'CE' };
  const g = greeks(input);

  it('matches the captured delta and prices a sane daily decay', () => {
    expect(g.delta).toBeGreaterThan(0.45);
    expect(g.delta).toBeLessThan(0.62);
    expect(g.gamma).toBeGreaterThan(0.05);
    expect(g.thetaDay).toBeLessThan(0);
    expect(Math.abs(g.thetaDay)).toBeGreaterThan(0.15);
    expect(Math.abs(g.thetaDay)).toBeLessThan(0.35);
  });

  it('mirrors delta for a put and refuses missing inputs', () => {
    const put = greeks({ ...input, side: 'PE' });
    expect(put.delta).toBeLessThan(0);
    expect(put.gamma).toBeCloseTo(g.gamma, 8);
    expect(greeks({ ...input, iv: 0 })).toBeNull();
  });
});

describe('optionIv', () => {
  it('prefers a sane captured IV and inverts when the feed carries none', () => {
    const base = { premium: 2.53, spot: 119.8, strike: 120, years: 5 / 365, side: 'CE' };
    expect(optionIv({ ...base, captured: 40.4 })).toBeCloseTo(0.404, 6);
    const inverted = optionIv({ ...base, captured: 0 });
    expect(inverted).toBeGreaterThan(0.05);
    expect(inverted).toBeLessThan(1.5);
  });
});

describe('premiumForMove / requiredMove round trip', () => {
  const g = greeks({ spot: 119.8, strike: 120, years: 5 / 365, iv: 0.404, side: 'CE' });
  const entry = 2.53;

  it('a +55% target needs about a 2% stock move in a day, and more over three', () => {
    const target = entry * 1.55;
    const one = requiredMove({ entry, target, delta: g.delta, gamma: g.gamma, thetaDay: g.thetaDay, days: 1 });
    const three = requiredMove({ entry, target, delta: g.delta, gamma: g.gamma, thetaDay: g.thetaDay, days: 3 });
    expect(one / 119.8 * 100).toBeGreaterThan(1.5);
    expect(one / 119.8 * 100).toBeLessThan(3);
    expect(three).toBeGreaterThan(one); // decay raises the bar
    const back = premiumForMove({ entry, move: one, delta: g.delta, gamma: g.gamma, thetaDay: g.thetaDay, days: 1 });
    expect(back).toBeCloseTo(target, 6);
  });

  it('prices an adverse move for the stop and reports the level for a put', () => {
    const stop = premiumForMove({ entry, move: -2, delta: g.delta, gamma: g.gamma, thetaDay: g.thetaDay, days: 1 });
    expect(stop).toBeLessThan(entry);
    expect(levelFor({ spot: 119.8, move: 2.5, side: 'CE' })).toMatchObject({ level: 122.3 });
    expect(levelFor({ spot: 4648, move: 152, side: 'PE' }).level).toBe(4496);
    expect(levelFor({ spot: 100, move: 2, side: 'CE' }).pct).toBeCloseTo(2, 6);
  });

  it('needs no move when decay already leaves the premium above the target, and refuses a zero delta', () => {
    expect(requiredMove({ entry: 2, target: 0.2, delta: 0.5, gamma: 0.07, thetaDay: -0.3, days: 5 })).toBe(0);
    expect(requiredMove({ entry: 2, target: 3, delta: 0, gamma: 0.07 })).toBeNull();
  });
});