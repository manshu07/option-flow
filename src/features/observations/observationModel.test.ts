import { describe, expect, it } from 'vitest';
import {
  highestObservedTarget,
  normalizeFollowThrough,
  observationKey,
  paginateObservationCards,
  sortObservationCards,
  uniqueObservationCards,
  type ObservationFollowThrough,
} from './observationModel';

describe('Observation identity', () => {
  it('uses symbol and session date as the card identity', () => {
    expect(observationKey({ id: 'timestamp-id', symbol: 'NIFTY', date: '2026-11-16' })).toBe('NIFTY|2026-11-16');
  });

  it('keeps the first card for each symbol/date and allows a new session card', () => {
    const newest = { id: 'new', symbol: 'NIFTY', date: '2026-11-16', entry: 100 };
    const duplicate = { id: 'old', symbol: 'NIFTY', date: '2026-11-16', entry: 90 };
    const nextDay = { id: 'next-day', symbol: 'NIFTY', date: '2026-11-17', entry: 110 };
    const otherSymbol = { id: 'other', symbol: 'SENSEX', date: '2026-11-16', entry: 200 };

    expect(uniqueObservationCards([newest, duplicate, nextDay, otherSymbol])).toEqual([newest, nextDay, otherSymbol]);
  });

  it('falls back to the persisted id when symbol/date are unavailable', () => {
    expect(uniqueObservationCards([{ id: 'legacy' }, { id: 'legacy' }, { id: 'other' }])).toEqual([{ id: 'legacy' }, { id: 'other' }]);
  });
});

describe('Observation ordering and pages', () => {
  it('sorts newest-first and keeps creation order for equal timestamps', () => {
    const first = { id: 'first', at: 20 };
    const second = { id: 'second', at: 20 };
    const newest = { id: 'newest', at: 30 };
    const oldest = { id: 'oldest', at: 10 };

    expect(sortObservationCards([first, oldest, second, newest])).toEqual([newest, first, second, oldest]);
  });

  it('slices ten cards, clamps the page, and reports the range and total pages', () => {
    const cards = Array.from({ length: 21 }, (_, index) => index);
    const second = paginateObservationCards(cards, 2, 10);
    expect(second).toMatchObject({ page: 2, pageSize: 10, total: 21, totalPages: 3, start: 11, end: 20 });
    expect(second.items).toEqual(cards.slice(10, 20));

    const clamped = paginateObservationCards(cards, 99, 10);
    expect(clamped).toMatchObject({ page: 3, totalPages: 3, start: 21, end: 21, items: [20] });
    expect(paginateObservationCards([], 4, 10)).toMatchObject({ page: 1, total: 0, totalPages: 0, start: 0, end: 0, items: [] });
  });
});

describe('Post-call follow-through evidence', () => {
  const report: ObservationFollowThrough = {
    version: 1,
    source: 'raw',
    from: 1_000,
    sessionCloseAt: 2_000,
    firstAt: 1_060,
    lastAt: 1_960,
    sampleCount: 16,
    expectedMinutes: 16,
    missingMinutes: 0,
    coverage: 'complete',
    range: { open: 100, high: 220, low: 80, close: 180 },
    touches: {
      sl: { at: 1_200, after: 1_200, source: 'ltp' },
      tgt1: { at: 1_500, after: 1_500, source: 'ltp' },
      tgt2: { at: 1_800, after: 1_700, source: 'day-range' },
    },
    sequence: 'sl-first',
  };

  it('normalizes the exact schema and recognizes the highest observed target', () => {
    const normalized = normalizeFollowThrough(report);
    expect(normalized).toEqual(report);
    expect(highestObservedTarget(normalized!)).toBe('tgt2');
  });

  it('returns no evidence for malformed reports instead of throwing', () => {
    expect(normalizeFollowThrough({ version: 1, coverage: 'partial' })).toBeNull();
    expect(normalizeFollowThrough(null)).toBeNull();
    expect(normalizeFollowThrough({ ...report, firstAt: 1e30 })).toBeNull();
    expect(normalizeFollowThrough({ ...report, touches: { ...report.touches, sl: { at: 900, after: 900, source: 'ltp' } } })).toBeNull();
    expect(normalizeFollowThrough({ ...report, touches: { ...report.touches, sl: { at: 1_200, after: 1_300, source: 'day-range' } } })).toBeNull();
  });

  it('keeps a target-first sequence distinct from ambiguous ordering', () => {
    expect(normalizeFollowThrough({ ...report, sequence: 'target-first', touches: { ...report.touches, sl: null } })?.sequence).toBe('target-first');
    expect(normalizeFollowThrough({ ...report, sequence: 'ambiguous' })?.sequence).toBe('ambiguous');
  });
});
