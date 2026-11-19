import { describe, expect, it } from 'vitest';
import { scoreStrikes } from './strikeChoice.mjs';

const NOW = Date.parse('2026-11-18T10:00:00+05:30');
const EXPIRY = '2026-12-29';

const grid = {
  instrument: 'EQ',
  cells: [{
    scope: 'hold:2', regime: 'range', side: 'CE', samples: 800,
    pairs: [
      { targetPct: 0.5, stopPct: 5, winRate: 0.74, lossRate: 0.02, openRate: 0.24, avgOpenR: 0.05, expectancyPct: 0.12, expectancyR: 0.024, win: 592, loss: 16, open: 192 },
      { targetPct: 2, stopPct: 5, winRate: 0.3, lossRate: 0.03, openRate: 0.67, avgOpenR: 0.1, expectancyPct: 0.2, expectancyR: 0.04, win: 240, loss: 24, open: 536 },
    ],
  }],
};

const candidates = [
  { id: 'c1', strike: 4600, side: 0, ltp: 121.25, iv: 22, delta: 0.55 },  // near ATM
  { id: 'c2', strike: 4800, side: 0, ltp: 42, iv: 24, delta: 0.3 },       // OTM
  { id: 'c3', strike: 5200, side: 0, ltp: 3.5, iv: 30, delta: 0.05 },     // lottery
];

describe('scoreStrikes', () => {
  it('prices the same move on every strike and ranks by rupee expectancy', () => {
    const { ranked, pair, days } = scoreStrikes({ candidates, spot: 4648, expiry: EXPIRY, side: 'CE', now: NOW, holdDays: 2, levelGrid: grid });
    expect(pair.targetPct).toBe(0.5);
    expect(days).toBe(2);
    expect(ranked).toHaveLength(3);
    for (const item of ranked) {
      expect(item.choice).not.toBeNull();
      expect(item.choice.winRate).toBe(0.74);
      expect(item.choice.targetPremium).toBeGreaterThan(0);
    }
    // The ATM leg earns the most rupees on a 0.5% move; the lottery leg least.
    expect(ranked[0].strike).toBe(4600);
    expect(ranked[ranked.length - 1].strike).toBe(5200);
    expect(ranked[0].choice.expectancyPremium).toBeGreaterThan(ranked[2].choice.expectancyPremium);
    // A cheap OTM leg can still show the bigger percentage gain.
    const otm = ranked.find(item => item.strike === 4800);
    expect(otm.choice.gainPct).toBeGreaterThan(ranked[0].choice.gainPct);
  });

  it('degrades honestly without a grid or without an expiry', () => {
    const noGrid = scoreStrikes({ candidates, spot: 4648, expiry: EXPIRY, side: 'CE', now: NOW, levelGrid: null });
    expect(noGrid.pair).toBeNull();
    expect(noGrid.ranked.every(item => item.choice === null)).toBe(true);
    const noExpiry = scoreStrikes({ candidates, spot: 4648, expiry: 'nonsense', side: 'CE', now: NOW, levelGrid: grid });
    expect(noExpiry.ranked.every(item => item.choice === null)).toBe(true);
    expect(scoreStrikes({ candidates: [], spot: 1, expiry: EXPIRY, side: 'CE' }).ranked).toEqual([]);
  });
});