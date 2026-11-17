import { describe, expect, it } from 'vitest';
import { capturePreviousOiBaseline, fillMissingPrevOi } from './oiBaseline.mjs';
import { marketMovers } from './alerts.mjs';

describe('previous-session captured OI baseline', () => {
  it('fills missing prevOi for matching contracts while preserving provider values', () => {
    const previous = {
      series: [{
        s: 'NIFTY', e: '2026-11-19',
        r: [[25_000, 0, 100, 90, 1_250_000, null], [25_000, 1, 80, 75, 900_000, null]],
      }],
    };
    const current = {
      date: '2026-11-17',
      series: [{
        s: 'NIFTY', e: '2026-11-19',
        r: [
          [25_000, 0, 110, 90, 1_300_000, null],
          [25_000, 1, 85, 75, 920_000, 880_000],
          [25_000, 0, 110, 90, 1_300_000, 1_000_001, 0, 0, 100, 20],
        ],
      }, {
        s: 'BANKNIFTY', e: '2026-11-19', r: [[25_000, 0, 100, 90, 500_000, null]],
      }, {
        s: 'NIFTY', e: '2026-11-26', r: [[25_000, 0, 100, 90, 500_000, null]],
      }],
    };

    const result = fillMissingPrevOi(current, capturePreviousOiBaseline(previous));

    expect(result.filled).toBe(1);
    expect(result.market.series[0].r[0][5]).toBe(1_250_000);
    expect(result.market.series[0].r[1][5]).toBe(880_000);
    expect(result.market.series[0].r[2][5]).toBe(1_000_001);
    expect(result.market.series[1].r[0][5]).toBeNull();
    expect(result.market.series[2].r[0][5]).toBeNull();
    expect(current.series[0].r[0][5]).toBeNull();
  });

  it('leaves rows unchanged when the previous snapshot has no matching contract', () => {
    const current = { series: [{ s: 'SENSEX', e: '2026-11-19', r: [[80_000, 0, 200, 190, 100_000, null]] }] };
    const result = fillMissingPrevOi(current, capturePreviousOiBaseline({ series: [] }));
    expect(result).toEqual({ market: current, filled: 0 });
  });

  it('makes a captured build-up OI-evaluable when only prevOi was missing', () => {
    const previous = { series: [{ s: 'NIFTY', e: '2026-11-19', r: [[25_000, 0, 9, 8, 100, null, 1]] }] };
    const current = { date: '2026-11-17', series: [{ s: 'NIFTY', sp: 25_300, pc: 25_000, e: '2026-11-19', r: [[25_000, 0, 10, 9, 103, null, 1]] }] };
    const enriched = fillMissingPrevOi(current, capturePreviousOiBaseline(previous));

    expect(enriched.filled).toBe(1);
    expect(marketMovers(enriched.market)).toMatchObject([{ symbol: 'NIFTY', buildup: 'LONG BUILD-UP', oiAdded: 3 }]);
  });
});
