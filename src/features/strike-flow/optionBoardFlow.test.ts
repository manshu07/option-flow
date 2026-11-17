import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/marketSession', () => ({
  getLatestTradingSessionDate: () => '2026-11-13',
  marketSessionBounds: () => ({ open: Date.parse('2026-11-13T03:45:00Z'), close: Date.parse('2026-11-13T10:10:00Z') }),
  isExpirySettled: (_expiry: string, at: number) => {
    if (!Number.isFinite(at)) throw new RangeError('Invalid time value');
    return false;
  },
}));
import { buildMarketFlow } from '../market-flow/marketFlowModel';
import { optionBoardFlow } from './optionBoardFlow';
import type { StrikeFlowPayload } from './feed';

const BASE = Date.parse('2026-11-13T03:45:00Z');
const MINUTE = 60_000;
function contract(strike: number, side: 'CE' | 'PE', prices: number[], oi: number[]): any {
  const series = prices.map((ltp, index) => [BASE + index * MINUTE, ltp, oi[index], 10 + index]);
  const last = series.at(-1);
  return { symbol: 'NIFTY', strike, side, expiry: '2026-11-19', prevClose: 100, prevOi: 1_000, ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null, spotDistancePct: 0, series };
}
const fixture: StrikeFlowPayload = {
  symbols: ['NIFTY'], symbol: 'NIFTY', date: '2026-11-13', expiry: { NIFTY: '2026-11-19' },
  spotPrevClose: { NIFTY: 24_900 },
  spot: { NIFTY: [[BASE, 25_000], [BASE + MINUTE, 25_010], [BASE + 2 * MINUTE, 25_020]] },
  strikes: {
    'NIFTY|25150|CE': contract(25_150, 'CE', [100, 110, 112], [1_000, 1_100, 1_200]),
    'NIFTY|25000|PE': contract(25_000, 'PE', [100, 95, 90], [1_000, 1_050, 1_100]),
  },
  minuteCount: 3,
};

describe("optionBoardFlow — the Option Board through Order Flow's pipeline", () => {
  it('builds', () => {
    const flow = optionBoardFlow({ payloads: [fixture], window: 'day', now: Date.parse('2026-11-13T10:00:00Z') });
    console.log('[day-window now=Nov13] stocks:', flow?.stocks.length ?? 'NULL');
    expect(flow).not.toBeNull();
    expect(flow!.stocks.length).toBe(2);
    const later = optionBoardFlow({ payloads: [fixture], window: 'day', now: Date.now() });
    console.log('[day-window now=real clock] stocks:', later?.stocks.length ?? 'NULL (nearSeries settled the chain)');
    const triple = optionBoardFlow({ payloads: [fixture, fixture, fixture], window: 'day', now: Date.now() });
    console.log('[three identical payloads] stocks:', triple?.stocks.length ?? 'NULL', triple?.stocks.map(st => st.symbol));
    expect(flow!.bullish.length).toBe(1);
    expect(flow!.bearish.length).toBe(1);
    expect(flow!.featured.bullish.length).toBe(1);
    expect(flow!.window).toBe('day');
    expect(flow!.asOf).toBe(Date.parse('2026-11-13T10:00:00Z'));

    // Direct buildMarketFlow probe with the same synthetic inputs
    const rows = [
      { strike: 25150, side: 'CE' as const, ltp: 112, prevClose: 100, oi: 1200, prevOi: 1000, volume: 12 },
      { strike: 25000, side: 'PE' as const, ltp: 90, prevClose: 100, oi: 1100, prevOi: 1000, volume: 12 },
    ];
    const series = [{
      symbol: 'NIFTY25150CE', kind: 'stock' as const, expiry: '2026-11-19', at: BASE + 2 * MINUTE, spot: 25020, spotPrevClose: 24900, atm: null, lot: 1, lotSource: 'catalogue' as const,
      quotes: rows.map(row => ({ strike: row.strike, side: row.side, ltp: row.ltp, prevClose: row.prevClose, oi: row.oi, prevOi: row.prevOi, volume: row.volume, prevVolumeLots: null, avgPrice: 0, iv: null, bid: 0, ask: 0, bidQty: 0, askQty: 0, dayHigh: null, dayLow: null, lastTradeAt: null, delta: null })),
      idle: [],
    }];
    const universe = [{ symbol: 'NIFTY25150CE', name: 'NIFTY 25150 CE', apiKey: 'x', lot: 1, kind: 'stock' as const, exch: 'NSE', sector: 'option' }];
    const futures = new Map([
      ['NIFTY25150CE', { symbol: 'NIFTY25150CE', contractDate: '2026-11-19', months: ['2026-11-19'], prevClose: 100, prevOi: 1000, candles: [100, 110, 112].map((close, index) => ({ at: BASE + index * MINUTE, close, oi: [1000, 1100, 1200][index] })) }],
    ]);
    try {
      const direct = buildMarketFlow(
        { schema: 1, t: BASE + 3 * MINUTE, date: '2026-11-13', series, minutes: [] } as never,
        futures as never,
        universe as never,
        { option: 'Option contracts' },
        { window: 'day', scope: 'all', floorPct: null, named: null, lines: 'all' },
        { now: BASE + 3 * MINUTE },
      );
      expect(direct.stocks.length).toBe(1);
      expect(direct.stocks[0]?.changePct).toBeCloseTo(12);
      expect(direct.stocks[0]?.side).toBe('bullish');
      expect(direct.featured.bullish.length).toBe(1);
    } catch (error) {
      console.log('direct THREW:', (error as Error).message);
      throw error;
    }
  });

  it('passes a valid capture timestamp into expiry-day market selection', () => {
    const expiryDate = '2026-11-13';
    const expiryPayload: StrikeFlowPayload = {
      ...fixture,
      expiry: { NIFTY: expiryDate },
      strikes: Object.fromEntries(Object.entries(fixture.strikes).map(([key, value]) => [key, { ...value, expiry: expiryDate }])),
    };
    const atClose = Date.parse('2026-11-13T10:10:00Z');

    const flow = optionBoardFlow({ payloads: [expiryPayload], window: 'day', now: atClose });

    expect(flow).not.toBeNull();
    expect(flow?.asOf).toBe(atClose);
  });
});
