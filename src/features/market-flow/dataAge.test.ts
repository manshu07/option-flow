import { describe, expect, it } from 'vitest';
import { describeDataAge, describeStale, STALE_MINUTES } from './dataAge';

const ist = (iso: string) => Date.parse(`${iso}+05:30`);

describe('describeDataAge', () => {
  it('is fresh when the reading is from the latest trading session, even after the close', () => {
    const age = describeDataAge(ist('2026-10-15T15:40:00'), ist('2026-10-15T18:00:00'));
    expect(age).toEqual({ aged: false, date: '2026-10-15' });
  });

  it('is aged when the reading is from an earlier session than the latest', () => {
    expect(describeDataAge(ist('2026-10-14T15:40:00'), ist('2026-10-15T11:00:00')).aged).toBe(true);
  });

  it('treats a weekend as part of Friday: a Friday reading read on Sunday is fresh', () => {
    expect(describeDataAge(ist('2026-10-16T15:40:00'), ist('2026-10-18T12:00:00')).aged).toBe(false);
  });
});

describe('describeStale', () => {
  it('is fresh while the reading is within the rebuild cadence', () => {
    expect(describeStale(ist('2026-11-18T14:20:00'), ist('2026-11-18T14:20:45'))).toEqual({ stale: false, minutes: 1 });
  });

  it('is stale once the reading falls behind the market rebuild', () => {
    expect(describeStale(ist('2026-11-18T14:10:00'), ist('2026-11-18T14:16:00'))).toEqual({ stale: true, minutes: 6 });
    expect(describeStale(ist('2026-11-18T14:16:30'), ist('2026-11-18T14:16:00')).stale).toBe(false); // clock skew never reads as stale
    expect(STALE_MINUTES).toBe(3);
  });

  it('says nothing without a reading', () => {
    expect(describeStale(Number.NaN, Date.now())).toEqual({ stale: false, minutes: null });
  });
});
