import { describe, expect, it } from 'vitest';
import { normalizeLiveTicks } from './liveTicks';

describe('normalizeLiveTicks', () => {
  it('keeps finite positive prices and drops incomplete stream values', () => {
    expect(normalizeLiveTicks({
      NIFTY: { ltp: 25_100.5 },
      BANKNIFTY: { ltp: null },
      SENSEX: { ltp: '70000' },
      TMPV: { ltp: Number.NaN },
      EMPTY: null,
      ZERO: { ltp: 0 },
    })).toEqual({ NIFTY: { ltp: 25_100.5 } });
  });

  it('returns an empty map for malformed top-level values', () => {
    expect(normalizeLiveTicks(null)).toEqual({});
    expect(normalizeLiveTicks([])).toEqual({});
    expect(normalizeLiveTicks('invalid')).toEqual({});
  });
});
