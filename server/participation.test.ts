import { describe, expect, it } from 'vitest';
import { participation, participationLabel, chainBlock, PARTICIPATION_LABELS } from './participation.mjs';

// Row layout: [strike, side(0=CE,1=PE), ltp, prevClose, oi, prevOi, volume, …]
const leg = (strike, side, oi, prevOi) => [strike, side, 10, 10, oi, prevOi, 1_000];

const near = (ceNow, ceBase, peNow, peBase) => ({ e: '2026-11-23', r: [leg(100, 0, ceNow, ceBase), leg(100, 1, peNow, peBase)] });
const next = (ceNow, ceBase, peNow, peBase) => ({ e: '2026-12-29', r: [leg(100, 0, ceNow, ceBase), leg(100, 1, peNow, peBase)] });

describe('participationLabel', () => {
  it('separates rollover from fresh build, unwind and steady', () => {
    expect(participationLabel(chainBlock(near(90, 100, 90, 100)), chainBlock(next(120, 100, 120, 100)))).toBe('rollover'); // near −10%, next +20%
    expect(participationLabel(chainBlock(near(101, 100, 101, 100)), chainBlock(next(120, 100, 120, 100)))).toBe('fresh build');
    expect(participationLabel(chainBlock(near(90, 100, 90, 100)), chainBlock(next(90, 100, 90, 100)))).toBe('unwind');
    expect(participationLabel(chainBlock(near(100, 100, 100, 100)), chainBlock(next(90, 100, 90, 100)))).toBe('next unwind');
    expect(participationLabel(chainBlock(near(100, 100, 100, 100)), chainBlock(next(100, 100, 100, 100)))).toBe('steady');
    expect(participationLabel(null, chainBlock(next(120, 100, 120, 100)))).toBe('not captured');
    expect(participationLabel(chainBlock(near(100, 100, 100, 100)), null)).toBe('not captured');
  });

  it('says baseline missing rather than pretending zero activity', () => {
    expect(participationLabel(chainBlock(near(100, 0, 100, 0)), chainBlock(next(120, 100, 120, 100)))).toBe('baseline missing');
  });
});

describe('participation', () => {
  it('ranks the biggest next-expiry build first and aggregates totals', () => {
    const series = [
      { s: 'ITC', sp: 110, pc: 100, ...near(90, 100, 90, 100), next: next(150, 100, 150, 100) }, // rollover, next +50%
      { s: 'SAIL', sp: 104, pc: 100, ...near(100, 100, 100, 100), next: next(110, 100, 110, 100) }, // fresh build +10%
      { s: 'IREDA', sp: 99, pc: 100, ...near(90, 100, 90, 100), next: next(90, 100, 90, 100) }, // unwind
      { s: 'IEX', sp: 100, pc: 100, ...near(100, 100, 100, 100) }, // no next block
    ];
    const result = participation(series);
    expect(result.rows.map(row => row.symbol)).toEqual(['ITC', 'SAIL', 'IREDA', 'IEX']);
    expect(result.rows[0]).toMatchObject({ symbol: 'ITC', label: 'rollover' });
    expect(result.rows[0].next).toMatchObject({ expiry: '2026-12-29', totalPct: 50, delta: 100 });
    expect(result.rows[0].near.totalPct).toBe(-10);
    expect(result.rows[3].label).toBe('not captured');
    expect(result.rows[3].next).toBeNull();
    expect(result.totals).toMatchObject({ symbols: 4, captured: 3, notCaptured: 1 });
    expect(result.totals.byLabel).toMatchObject({ rollover: 1, 'fresh build': 1, unwind: 1, 'not captured': 1 });
    expect(result.totals.nextPct).toBeCloseTo(100 / 600 * 100, 6); // next legs: 300+220+180 vs 600 base
    expect(Object.keys(result.totals.byLabel)).toEqual(PARTICIPATION_LABELS);
  });

  it('honours the limit and survives an empty file', () => {
    const series = [
      { s: 'ITC', sp: 110, pc: 100, ...near(90, 100, 90, 100), next: next(150, 100, 150, 100) },
      { s: 'SAIL', sp: 104, pc: 100, ...near(100, 100, 100, 100), next: next(110, 100, 110, 100) },
    ];
    expect(participation(series, { limit: 1 }).rows).toHaveLength(1);
    const empty = participation([]);
    expect(empty.rows).toHaveLength(0);
    expect(empty.totals.nearPct).toBeNull();
    expect(empty.totals.nextPct).toBeNull();
  });
});