import { describe, expect, it } from 'vitest';
import { liveErrorMessage, liveSnapshotMessage } from './liveCommand.mjs';

function row(strike: number, side: number, oi: number, prevOi: number) {
  return [strike, side, 10, 9, oi, prevOi, 1, 0, 10, null, 0, 0, 0, 0, 11, 8, null, null];
}

describe('live command message', () => {
  it('uses captured chains and supplied live caches for the requested side', () => {
    const market = {
      date: '2026-11-16',
      t: Date.parse('2026-11-16T04:17:00Z'),
      series: [{
        s: 'NIFTY', sp: 101, pc: 100,
        r: [row(105, 0, 2_000, 1_000), row(110, 0, 4_000, 1_500), row(100, 1, 1_500, 1_000), row(95, 1, 3_000, 1_500)],
      }],
    };

    const text = liveSnapshotMessage({
      symbol: 'NIFTY',
      side: 'CE',
      market,
      spotReading: { ltp: 102, prevClose: 100, at: market.t },
      futureReading: { ltp: 103.25, at: market.t },
    });

    expect(text).toContain('<b>NIFTY snapshot</b>');
    expect(text).toContain('Spot <b>102.00</b> · day +2.0%');
    expect(text).toContain('Futures <b>103.25</b> (live cache)');
    expect(text).toContain('<b>LONG BUILD-UP</b>');
    expect(text).toContain('Nearest walls: CE 105 (OI 2.0K) · PE 100 (OI 1.5K)');
    expect(text).toContain('Top OI gainer (CE): CE 110 +166.7%');
    expect(text).not.toContain('PE 95');
    expect(text).toContain('not investment advice');
    expect(text.length).toBeLessThan(900);
  });

  it('falls back to captured spot and states when cached futures are unavailable', () => {
    const text = liveSnapshotMessage({
      symbol: 'TMPV',
      market: { date: '2026-11-16', series: [{ s: 'TMPV', sp: 250, pc: 250, r: [] }] },
    });

    expect(text).toContain('Spot <b>250.00</b>');
    expect(text).toContain('Futures unavailable in this provider\'s live cache');
    expect(text).toContain('not investment advice');
  });

  it('returns an honest escaped response for unsupported symbols', () => {
    const text = liveErrorMessage('<UNKNOWN>', 'unknown or unsupported symbol.');

    expect(text).toContain('&lt;UNKNOWN&gt;');
    expect(text).not.toContain('<UNKNOWN>');
    expect(text).toContain('not investment advice');
  });
});
