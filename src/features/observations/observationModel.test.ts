import { describe, expect, it } from 'vitest';
import {
  filterObservationCards,
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

  it('preserves legacy reports and accepts only a valid full-minute futures range', () => {
    expect(normalizeFollowThrough(report)).not.toHaveProperty('futures');
    expect(normalizeFollowThrough({ ...report, futures: null })).toHaveProperty('futures', null);
    const at = Date.parse('2026-11-16T09:45:23+05:30');
    const first = Date.parse('2026-11-16T09:46:00+05:30');
    const current = {
      ...report,
      from: at,
      firstAt: first,
      lastAt: first + 60_000,
      sessionCloseAt: Date.parse('2026-11-16T15:40:00+05:30'),
      // Touches must live inside the new real-epoch window, or the parser
      // correctly rejects the report as internally inconsistent.
      touches: {
        sl: { at: first + 30_000, after: first + 30_000, source: 'ltp' as const },
        tgt1: { at: first + 60_000, after: first + 60_000, source: 'ltp' as const },
        tgt2: { at: first + 120_000, after: first + 90_000, source: 'day-range' as const },
      },
    };
    const futures = { high: 25_600, low: 25_100, from: first, to: first + 120_000 };
    expect(normalizeFollowThrough({ ...current, futures })?.futures).toEqual(futures);
    expect(normalizeFollowThrough({ ...current, futures: { ...futures, from: first - 60_000 } })?.futures).toBeNull();
    expect(normalizeFollowThrough({ ...current, futures: { ...futures, high: 'bad' } })?.futures).toBeNull();
    expect(normalizeFollowThrough({ ...current, futures: { ...futures, to: current.sessionCloseAt + 60_000 } })?.futures).toBeNull();
  });
});

describe('filterObservationCards', () => {
  const early = { id: 'e', symbol: 'E', date: '2026-11-19', at: 3, early: 'momentum' as const, quality: null as unknown as number };
  const jevLow = { id: 'j1', symbol: 'J1', date: '2026-11-19', at: 2, early: null, quality: 0.7 };
  const jevHigh = { id: 'j2', symbol: 'J2', date: '2026-11-19', at: 1, early: null, quality: 0.86 };
  const cards = [early, jevLow, jevHigh];

  it('splits early code signals from Jev model cards', () => {
    expect(filterObservationCards(cards, { signal: 'early' }).map((c: { id: string }) => c.id)).toEqual(['e']);
    expect(filterObservationCards(cards, { signal: 'jev' }).map((c: { id: string }) => c.id)).toEqual(['j1', 'j2']);
    expect(filterObservationCards(cards, { signal: 'all' })).toHaveLength(3);
  });

  it('applies a confidence floor and drops early cards that have no score', () => {
    expect(filterObservationCards(cards, { confidence: '65' }).map((c: { id: string }) => c.id)).toEqual(['j1', 'j2']);
    expect(filterObservationCards(cards, { confidence: '80' }).map((c: { id: string }) => c.id)).toEqual(['j2']);
    expect(filterObservationCards(cards, { signal: 'early', confidence: '80' })).toHaveLength(0);
  });

  it('searches symbol, contract and expiry case-insensitively', () => {
    const searchable = [
      { id: 'a', symbol: 'IREDA', date: '2026-11-19', at: 3, strike: 128, side: 'CE', expiry: '2026-11-23' },
      { id: 'b', symbol: 'TITAN', date: '2026-11-19', at: 2, strike: 3400, side: 'PE', expiry: '2026-12-28' },
    ];
    expect(filterObservationCards(searchable, { query: 'ireda' }).map(c => c.id)).toEqual(['a']);
    expect(filterObservationCards(searchable, { query: '128ce' }).map(c => c.id)).toEqual(['a']);
    expect(filterObservationCards(searchable, { query: '2026-12' }).map(c => c.id)).toEqual(['b']);
    expect(filterObservationCards(searchable, { query: 'titan pe' }).map(c => c.id)).toEqual(['b']);
    expect(filterObservationCards(searchable, { query: 'zzz' })).toHaveLength(0);
  });

  it('treats a blank query as no search and combines with the signal filter', () => {
    expect(filterObservationCards(cards, { query: '   ' })).toHaveLength(3);
    expect(filterObservationCards(cards, {})).toHaveLength(3);
    expect(filterObservationCards(cards, { signal: 'jev', query: 'j2' }).map((c: { id: string }) => c.id)).toEqual(['j2']);
    expect(filterObservationCards(cards, { signal: 'early', query: 'j' })).toHaveLength(0);
  });
});
