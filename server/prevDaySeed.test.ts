import { describe, expect, it } from 'vitest';
import { seedPlan } from './prevDaySeed.mjs';

// 18-field leg layout: [strike, side, ltp, prevClose, oi, prevOi, volume, prevVolume, …]
const leg = (strike, side, prevClose, oi, prevOi, volume, prevVolume) => [strike, side, 10, prevClose, oi, prevOi, volume, prevVolume];

const SESSION = '2026-11-18';
const seriesRow = {
  e: '2026-11-23',
  r: [leg(2000, 0, 23.9, 117900, 118500, 92400, 146700), leg(2000, 1, 12.5, 600, 900, 31100, 40000)],
  next: { e: '2026-12-29', r: [leg(2000, 0, 61.4, 600, 800, 900, 1500), leg(2000, 1, 55.1, 500, 700, 800, 1200)] },
};

const windows = [
  { expiry: '2026-11-23', window: [2000], ids: new Map([[2000, { CE: 'near-ce', PE: 'near-pe' }]]) },
  { expiry: '2026-12-29', window: [2000], ids: new Map([[2000, { CE: 'next-ce', PE: 'next-pe' }]]) },
];

describe('seedPlan', () => {
  it('seeds the near expiry from a same-session snapshot and never borrows its rows for the next expiry', () => {
    const plan = seedPlan(seriesRow, windows, { session: SESSION, snapshotSession: SESSION });
    expect(plan).toEqual([
      { legKey: 'near-ce', prevOi: 118500, prevClose: 23.9, prevVolume: 146700 },
      { legKey: 'near-pe', prevOi: 900, prevClose: 12.5, prevVolume: 40000 },
    ]);
  });

  it('seeds the next expiry from an earlier session close OI, not that day\'s prevOi', () => {
    const plan = seedPlan(seriesRow, windows, { session: SESSION, snapshotSession: '2026-11-17' });
    expect(plan).toEqual([
      // earlier session → row[4] (close OI) is the baseline for every window
      { legKey: 'near-ce', prevOi: 117900, prevClose: 23.9, prevVolume: 146700 },
      { legKey: 'near-pe', prevOi: 600, prevClose: 12.5, prevVolume: 40000 },
      { legKey: 'next-ce', prevOi: 600, prevClose: 61.4, prevVolume: 1500 },
      { legKey: 'next-pe', prevOi: 500, prevClose: 55.1, prevVolume: 1200 },
    ]);
  });

  it('skips the next window when the snapshot has no next block', () => {
    const plan = seedPlan({ ...seriesRow, next: undefined }, windows, { session: SESSION, snapshotSession: '2026-11-17' });
    expect(plan.map(item => item.legKey)).toEqual(['near-ce', 'near-pe']);
  });

  it('skips legs the snapshot does not carry, and never invents a zero baseline', () => {
    const rows = { e: '2026-11-23', r: [leg(2000, 0, 23.9, 117900, null, 111, 222), leg(2000, 1, 12.5, 600, 43200, 111, 31100)] };
    expect(seedPlan(rows, [{ expiry: '2026-11-23', window: [2000, 2100], ids: new Map([[2000, { CE: 'ce' }], [2100, { CE: 'missing' }]]) }], { session: SESSION, snapshotSession: SESSION })).toEqual([]);
    expect(seedPlan(rows, [{ expiry: '2026-11-23', window: [2000], ids: new Map([[2000, { PE: 'pe' }]]) }], { session: SESSION, snapshotSession: SESSION }))
      .toEqual([{ legKey: 'pe', prevOi: 43200, prevClose: 12.5, prevVolume: 31100 }]);
  });
});