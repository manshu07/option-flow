import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMoveStats, entryBucket, moveFor, reachRate } from './moveStats.mjs';

const stats = {
  symbol: 'TEST',
  instrument: 'EQ',
  entryTimes: ['09:30', '12:30', '14:30'],
  holds: [1, 2, 5],
  intraday: {
    '09:30': { recent: { up: { n: 700, p30: 0.45, p50: 0.7, p70: 1.1, p85: 1.6, p95: 2.6 }, down: { n: 700, p30: 0.44, p50: 0.68, p70: 1.05, p85: 1.5, p95: 2.4 } } },
    '12:30': { recent: { up: { n: 700, p50: 0.4, p70: 0.7, p85: 1.1, p95: 1.8 }, down: { n: 700, p50: 0.4, p70: 0.7, p85: 1.0, p95: 1.7 } } },
    '14:30': { recent: { up: { n: 700, p50: 0.25, p70: 0.45, p85: 0.7, p95: 1.2 }, down: { n: 700, p50: 0.24, p70: 0.42, p85: 0.66, p95: 1.1 } } },
  },
  daily: {
    1: { recent: { up: { n: 700, p50: 0.8, p70: 1.3, p85: 2.0, p95: 3.1 }, down: { n: 700, p50: 0.8, p70: 1.3, p85: 2.0, p95: 3.0 } } },
    2: { recent: { up: { n: 700, p50: 1.2, p70: 1.9, p85: 2.8, p95: 4.2 }, down: { n: 700, p50: 1.2, p70: 1.9, p85: 2.8, p95: 4.1 } } },
    5: { recent: { up: { n: 700, p50: 2.1, p70: 3.3, p85: 5.0, p95: 7.4 }, down: { n: 700, p50: 2.0, p70: 3.1, p85: 4.7, p95: 7.0 } } },
  },
};

describe('loadMoveStats', () => {
  it('reads an EQ stats file and refuses anything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'move-stats-'));
    try {
      writeFileSync(join(dir, 'TEST.json'), JSON.stringify(stats));
      writeFileSync(join(dir, 'BAD.json'), JSON.stringify({ instrument: 'FUT', intraday: {}, daily: {} }));
      expect(loadMoveStats(dir, 'TEST').symbol).toBe('TEST');
      expect(loadMoveStats(dir, 'BAD')).toBeNull();
      expect(loadMoveStats(dir, 'MISSING')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('moveFor', () => {
  it('uses the entry bucket at or before the card time — a late card asks for less', () => {
    expect(entryBucket(stats, '13:05')).toBe('12:30');
    expect(entryBucket(stats, '09:20')).toBeNull();
    const morning = moveFor({ stats, hhmm: '09:35', holdDays: 0, side: 'CE' });
    const late = moveFor({ stats, hhmm: '14:45', holdDays: 0, side: 'CE' });
    expect(morning.pct).toBe(1.1);
    expect(late.pct).toBe(0.45);
    expect(morning.samples).toBe(700);
    expect(morning.instrument).toBe('EQ');
  });

  it('picks the nearest hold and the put side for a PE', () => {
    const swing = moveFor({ stats, hhmm: '10:00', holdDays: 3, side: 'PE', percentile: 85 });
    expect(swing.holdDays).toBe(2);
    expect(swing.pct).toBe(2.8);
    expect(swing.basis).toBe('daily');
    expect(moveFor({ stats: null, hhmm: '10:00' })).toBeNull();
  });
});

describe('reachRate', () => {
  it('reports how often the past windows reached the level', () => {
    expect(reachRate({ stats, hhmm: '09:35', holdDays: 0, side: 'CE', pct: 0.45 })).toBeCloseTo(0.7, 6);
    expect(reachRate({ stats, hhmm: '09:35', holdDays: 0, side: 'CE', pct: 1.1 })).toBeCloseTo(0.3, 6);
    expect(reachRate({ stats, hhmm: '09:35', holdDays: 0, side: 'CE', pct: 1.6 })).toBeCloseTo(0.15, 6);
    const between = reachRate({ stats, hhmm: '09:35', holdDays: 0, side: 'CE', pct: 1.35 });
    expect(between).toBeGreaterThan(0.15);
    expect(between).toBeLessThan(0.3);
    expect(reachRate({ stats, hhmm: '09:35', holdDays: 0, side: 'CE', pct: 9 })).toBeLessThan(0.06);
    expect(reachRate({ stats: null, pct: 1 })).toBeNull();
  });
});