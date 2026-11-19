import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLevelGrid, cellFor, pickPair, pickPairForStrike, pricePair, POLICIES } from './levelPolicy.mjs';

const pair = (targetPct, stopPct, winRate, lossRate, expectancyPct, avgOpenR = 0) => ({
  targetPct, stopPct, winRate, lossRate, openRate: Math.max(0, 1 - winRate - lossRate),
  expectancyPct, expectancyR: expectancyPct / stopPct, avgOpenR,
  win: Math.round(winRate * 500), loss: Math.round(lossRate * 500), open: 0,
});

const grid = {
  instrument: 'EQ',
  cells: [
    {
      scope: 'hold:2', regime: 'up', side: 'CE', samples: 551,
      pairs: [
        pair(0.3, 8, 0.80, 0.005, -0.16),  // hits often, still loses
        pair(0.5, 8, 0.74, 0.007, -0.12),
        pair(2, 8, 0.31, 0.0, 0.22),       // best expectancy, low hit rate
        pair(0.8, 3, 0.60, 0.08, 0.05),    // fails the achievable stop rule
      ],
    },
    { scope: 'hold:2', regime: 'range', side: 'CE', samples: 900, pairs: [pair(1, 5, 0.5, 0.02, 0.1)] },
    { scope: 'intraday:09:30', regime: 'up', side: 'CE', samples: 400, pairs: [pair(0.3, 2, 0.72, 0.02, 0.04)] },
  ],
};

describe('loadLevelGrid / cellFor', () => {
  it('loads an EQ grid and matches scope, regime and side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'level-grid-'));
    try {
      writeFileSync(join(dir, 'TEST.json'), JSON.stringify(grid));
      const loaded = loadLevelGrid(dir, 'TEST');
      expect(cellFor({ grid: loaded, holdDays: 2, regime: 'up', side: 'CE' }).samples).toBe(551);
      expect(cellFor({ grid: loaded, holdDays: 0, hhmm: '09:30', regime: 'up', side: 'CE' }).scope).toBe('intraday:09:30');
      // An unknown regime falls back to the pooled range cell.
      expect(cellFor({ grid: loaded, holdDays: 2, regime: 'down', side: 'CE' }).regime).toBe('range');
      expect(cellFor({ grid: null, holdDays: 2, regime: 'up', side: 'CE' })).toBeNull();
      expect(loadLevelGrid(dir, 'MISSING')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('pickPair', () => {
  const cell = grid.cells[0];

  it('honours the achievable policy: high hit rate, rarely-hit stop', () => {
    const chosen = pickPair(cell, { policy: 'achievable' });
    expect(chosen.constrained).toBe(true);
    expect(chosen.winRate).toBeGreaterThanOrEqual(POLICIES.achievable.minWin);
    expect(chosen.lossRate).toBeLessThanOrEqual(POLICIES.achievable.maxLoss);
    // Among the eligible pairs it still ranks by expectancy, not by hit rate.
    expect(chosen.targetPct).toBe(0.5);
    expect(chosen.expectancyPct).toBe(-0.12); // honest: this choice lost money historically
  });

  it('the expectancy policy ignores hit rate and takes the best earner', () => {
    const chosen = pickPair(cell, { policy: 'expectancy' });
    expect(chosen.targetPct).toBe(2);
    expect(chosen.expectancyPct).toBe(0.22);
  });

  it('refuses a cell with too few samples', () => {
    expect(pickPair({ ...cell, samples: 40 })).toBeNull();
    expect(pickPair(null)).toBeNull();
  });
});

describe('pricePair', () => {
  it('converts the chosen pair into premium levels and a rupee expectancy', () => {
    const chosen = pickPair(grid.cells[0], { policy: 'achievable' });
    const priced = pricePair({
      pair: chosen, spot: 4648, strike: 4600, entry: 121.25,
      years: 41 / 365, iv: 0.22, side: 'CE', days: 2,
    });
    expect(priced.targetLevel).toBeGreaterThan(4648);
    expect(priced.stopLevel).toBeLessThan(4648);
    expect(priced.targetPremium).toBeGreaterThan(121.25);
    expect(priced.stopPremium).toBeLessThan(121.25);
    expect(priced.rewardRisk).toBeGreaterThan(0);
    expect(Number.isFinite(priced.expectancyPremium)).toBe(true);
    expect(pricePair({ pair: null, spot: 1, strike: 1, entry: 1, years: 0.1, iv: 0.2, side: 'CE', days: 1 })).toBeNull();
  });
});

describe('pickPairForStrike', () => {
  // A tight stop is what makes a 1:2 payoff possible on a bought option.
  const cell = {
    scope: 'hold:2', regime: 'up', side: 'CE', samples: 500,
    pairs: [
      pair(0.5, 8, 0.80, 0.005, -0.1),   // never stopped, but pays nothing
      pair(3, 1.5, 0.75, 0.15, 0.2),    // achievable AND payable (target ≈ 2x stop)
      pair(3, 0.5, 0.11, 0.35, 0.3),    // big payoff, rarely reached
    ],
  };
  const base = { cell, spot: 4648, strike: 4700, entry: 100, years: 41 / 365, iv: 0.22, side: 'CE', days: 2 };

  it('demands at least 1:2 in premium and prefers the achievable pair', () => {
    const chosen = pickPairForStrike(base);
    expect(chosen.pair).not.toBeNull();
    expect(chosen.pair.rewardRisk).toBeGreaterThanOrEqual(2);
    expect(chosen.pair.targetPct).toBe(3);
    expect(chosen.pair.stopPct).toBe(1.5);
    expect(chosen.pair.constrained).toBe(true);
  });

  it('refuses a target beyond the chain wall', () => {
    // Resistance sits below every target level → nothing is achievable.
    const blocked = pickPairForStrike({ ...base, wall: 4650 });
    expect(blocked.pair).toBeNull();
    expect(blocked.reason).toContain('no pair could be priced');
  });

  it('says so when nothing pays 1:2 instead of quoting a bad trade', () => {
    const wideOnly = { ...cell, pairs: [pair(0.3, 8, 0.8, 0.005, -0.1)] };
    const chosen = pickPairForStrike({ ...base, cell: wideOnly });
    expect(chosen.pair).toBeNull();
    expect(chosen.reason).toContain('reward:risk');
  });

  it('needs enough history', () => {
    expect(pickPairForStrike({ ...base, cell: { ...cell, samples: 20 } }).reason).toBe('not enough history');
  });
});
