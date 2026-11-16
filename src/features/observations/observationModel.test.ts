import { describe, expect, it } from 'vitest';
import { observationKey, uniqueObservationCards } from './observationModel';

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
