import { describe, expect, it } from 'vitest';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint } from './feed';
import { strikeReadings } from './strikeFlowModel';
import { spotChangeForWindow, strikeCardChecks, strikePremiumZone, strikeWalls } from './strikeCardModel';

const DATE = '2026-11-13';
const BASE = Date.parse('2026-11-13T03:45:00Z');
const MINUTE = 60_000;

function quote(strike: number, side: 'CE' | 'PE', oi: number | null, ltp = 100, series?: StrikeSeriesPoint[]): StrikeFlowContract {
  const history = series ?? [[BASE, ltp, oi, 10], [BASE + MINUTE, ltp + 1, oi, 20]];
  const last = history.at(-1);
  return {
    strike, side, expiry: '2026-11-19', prevClose: 100, prevOi: 1_000,
    ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null,
    spotDistancePct: ((strike - 25_000) / 25_000) * 100, series: history,
  };
}

function flow(strikes: StrikeFlowContract[], spot = 25_000, spotPrevClose: number | null = 24_900): StrikeFlowPayload {
  return {
    symbol: 'NIFTY', date: DATE, expiry: '2026-11-19', spotPrevClose,
    spot: [[BASE, spot], [BASE + MINUTE, spot + 10]],
    strikes: Object.fromEntries(strikes.map(item => [`${item.strike}|${item.side}`, item])), minuteCount: 2,
  };
}

describe('strike card model', () => {
  it('builds support from PE OI below spot and resistance from CE OI above spot', () => {
    const walls = strikeWalls(flow([
      quote(25_150, 'PE', 99_000),
      quote(25_100, 'PE', 1_000),
      quote(25_050, 'PE', 2_000),
      quote(25_250, 'PE', 88_000),
      quote(25_200, 'CE', 1_500),
      quote(25_300, 'CE', 2_500),
      quote(25_100, 'CE', 77_000),
    ], 25_140));

    expect(walls.support).toEqual({ strike: 25_050, oi: 2_000 });
    expect(walls.resistance).toEqual({ strike: 25_300, oi: 2_500 });
  });

  it('uses spotPrevClose for the day move and the shared tolerance for intraday', () => {
    const day = flow([quote(25_000, 'CE', 1_100)], 25_010);
    expect(spotChangeForWindow(day, 'day')).toBeCloseTo((25_020 / 24_900 - 1) * 100);
    expect(spotChangeForWindow(flow([], 25_010, null), 'day')).toBeNull();

    const spotHistory: StrikeFlowPayload = {
      ...day,
      spot: [[BASE, 25_000], [BASE + 5 * MINUTE, 25_010], [BASE + 10 * MINUTE, 25_020]],
    };
    expect(spotChangeForWindow(spotHistory, '5m')).toBeCloseTo((25_020 / 25_010 - 1) * 100);
    expect(spotChangeForWindow({ ...spotHistory, spot: [[BASE, 25_000], [BASE + 7 * MINUTE, 25_020]] }, '5m')).toBeNull();
  });

  it('measures the card premium zone from the selected contract window', () => {
    const history: StrikeSeriesPoint[] = [[BASE, 100, 1_000, 10], [BASE + 5 * MINUTE, 103, 1_100, 20], [BASE + 10 * MINUTE, 99, 1_200, 30]];
    const selected = flow([quote(25_000, 'CE', 1_200, 99, history)]);
    const [reading] = strikeReadings(selected, '5m');

    expect(strikePremiumZone(reading, '5m')).toEqual({ low: 99, high: 103 });
    expect(strikePremiumZone(reading, 'day')).toEqual({ low: 99, high: 103 });
  });

  it('keeps five conviction checks and does not count unavailable evidence as failed', () => {
    const item = { ...quote(25_000, 'CE', null, 105, [[BASE, 100, null, null], [BASE + MINUTE, 105, null, null]]), prevClose: null, prevOi: null, spotDistancePct: null };
    const [reading] = strikeReadings(flow([item], 25_020, null), 'day');
    const checks = strikeCardChecks(reading, null, 'day');

    expect(checks.map(check => check.id)).toEqual(['premium', 'oi', 'volume', 'distance', 'spot']);
    expect(checks.every(check => check.pass === null)).toBe(true);
  });

  it('checks positive volume pace and call/spot direction agreement', () => {
    const item = quote(25_000, 'CE', 1_200, 110, [[BASE, 100, 1_000, 100], [BASE + MINUTE, 110, 1_200, 200]]);
    const [reading] = strikeReadings(flow([item], 25_200, 25_000), 'day');
    const checks = strikeCardChecks(reading, 0.8, 'day');

    expect(checks.find(check => check.id === 'volume')?.pass).toBe(true);
    expect(checks.find(check => check.id === 'spot')?.pass).toBe(true);
  });
});
