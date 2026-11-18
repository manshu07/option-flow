import { describe, expect, it } from 'vitest';
import { dteOf, signalStats, signalStatsLines } from './journalStats.mjs';

const card = (over: Record<string, unknown> = {}) => ({
  symbol: 'X', date: '2026-11-18', expiry: '2026-11-23', side: 'CE',
  quality: 0.8, early: null, strategy: { qualifies: true },
  outcome: { status: 'tgt1', r: 1.2 }, ...over,
});

describe('signalStats', () => {
  it('separates early momentum, early build-fast and model cards with win rate and avg R', () => {
    const stats = signalStats([
      card({ early: 'momentum', outcome: { status: 'tgt1', r: 1.2 } }),
      card({ early: 'momentum', outcome: { status: 'sl', r: -1 } }),
      card({ early: 'build-fast', outcome: { status: 'sl', r: -1 } }),
      card({ quality: 0.8, outcome: { status: 'tgt1', r: 2 } }),
    ]);
    const momentum = stats.find(item => item.key === 'signal:early-momentum')!;
    expect(momentum).toMatchObject({ cards: 2, resolved: 2, tgt1: 1, sl: 1, winRate: 0.5 });
    expect(momentum.avgR).toBeCloseTo(0.1, 5);
    const model = stats.find(item => item.key === 'signal:model')!;
    expect(model).toMatchObject({ cards: 1, winRate: 1 });
    expect(model.avgR).toBe(2);
    const build = stats.find(item => item.key === 'signal:early-build-fast')!;
    expect(build.winRate).toBe(0);
  });

  it('counts ambiguous as a resolved loss and open cards as unresolved', () => {
    const stats = signalStats([
      card({ outcome: { status: 'ambiguous', r: -1 } }),
      card({ outcome: { status: 'open', r: null } }),
      card({ outcome: undefined }),
    ]);
    const model = stats.find(item => item.key === 'signal:model')!;
    expect(model).toMatchObject({ cards: 3, resolved: 1, tgt1: 0, ambiguous: 1, open: 2, winRate: 0 });
  });

  it('buckets by DTE and skips cards without an expiry there', () => {
    expect(dteOf(card())).toBe(5);
    const stats = signalStats([
      card({ date: '2026-11-18', expiry: '2026-11-21' }), // 3 DTE
      card({ date: '2026-11-18', expiry: '2026-11-23' }), // 5 DTE
      card({ date: '2026-11-18', expiry: '2026-12-31' }), // 43 DTE
      card({ expiry: null }),
    ]);
    expect(stats.find(item => item.key === 'dte:dte-0-3')?.cards).toBe(1);
    expect(stats.find(item => item.key === 'dte:dte-4-7')?.cards).toBe(1);
    expect(stats.find(item => item.key === 'dte:dte-8-plus')?.cards).toBe(1);
    const dteTotal = stats.filter(item => item.key.startsWith('dte:')).reduce((sum, item) => sum + item.cards, 0);
    expect(dteTotal).toBe(3);
  });

  it('splits ORB qualified, failed and untagged cards', () => {
    const stats = signalStats([
      card({ strategy: { qualifies: true } }),
      card({ strategy: { qualifies: false } }),
      card({ strategy: undefined }),
    ]);
    expect(stats.find(item => item.key === 'orb:orb-yes')?.cards).toBe(1);
    expect(stats.find(item => item.key === 'orb:orb-no')?.cards).toBe(1);
    expect(stats.find(item => item.key === 'orb:orb-none')?.cards).toBe(1);
  });

  it('drops thin buckets under minSample and returns [] for no cards', () => {
    expect(signalStats([], {})).toEqual([]);
    const stats = signalStats([card(), card()], { minSample: 2 });
    expect(stats.every(item => item.cards >= 2)).toBe(true);
    expect(signalStats([card()], { minSample: 2 })).toEqual([]);
  });

  it('renders compact lines only for buckets with resolved outcomes', () => {
    const lines = signalStatsLines([card({ early: 'momentum' }), card({ outcome: { status: 'open', r: null } })]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('early · momentum');
    expect(lines[0]).toContain('win 100%');
  });
});