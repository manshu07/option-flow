import { describe, expect, it } from 'vitest';
import { buildUpWord } from '../options-scanner/scannerWords';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint, StrikeSide } from './feed';
import { filterStrikeReadings, strikeReadings, type StrikeFlowWindow } from './strikeFlowModel';

const DATE = '2026-11-13';
const BASE_AT = Date.parse('2026-11-13T03:45:00.000Z');
const MINUTE = 60_000;

function point(offsetMinutes: number, ltp: number, oi: number | null, volume: number | null = 5): StrikeSeriesPoint {
  return [BASE_AT + offsetMinutes * MINUTE, ltp, oi, volume];
}

function contract(
  strike: number,
  side: StrikeSide,
  series: StrikeSeriesPoint[],
  overrides: Partial<StrikeFlowContract> = {},
): StrikeFlowContract {
  const last = series.at(-1);
  return {
    strike,
    side,
    expiry: '2026-11-19',
    prevClose: 100,
    prevOi: 1_000,
    ltp: last?.[1] ?? null,
    oi: last?.[2] ?? null,
    volume: last?.[3] ?? null,
    spotDistancePct: 0,
    series,
    ...overrides,
  };
}

function flow(...contracts: StrikeFlowContract[]): StrikeFlowPayload {
  return {
    symbol: 'NIFTY',
    date: DATE,
    expiry: '2026-11-19',
    spot: [[BASE_AT, 25_000]],
    strikes: Object.fromEntries(contracts.map(item => [`${item.strike}|${item.side}`, item])),
    minuteCount: 1,
  };
}

describe('strikeReadings', () => {
  it('measures the day against the previous close and OI', () => {
    const reading = strikeReadings(flow(contract(25_000, 'CE', [point(0, 105, 1_120)], { prevClose: 100, prevOi: 1_000 })), 'day')[0];

    expect(reading.premiumChange).toBe(5);
    expect(reading.premiumChangePct).toBe(5);
    expect(reading.premiumBaselineLtp).toBe(100);
    expect(reading.premiumBaselineAt).toBeNull();
    expect(reading.oiChange).toBe(120);
    expect(reading.oiChangePct).toBe(12);
    expect(reading.direction).toBe('up');
    expect(reading.buildUp).toBe('LONG_BUILD');
    expect(reading.rank).toBe(1);
  });

  it('leaves percentages and OI changes null when the day baseline is missing', () => {
    const reading = strikeReadings(flow(contract(25_000, 'CE', [point(0, 105, 1_100)], { prevClose: null, prevOi: null })), 'day')[0];

    expect(reading.premiumChange).toBeNull();
    expect(reading.premiumChangePct).toBeNull();
    expect(reading.oiChange).toBeNull();
    expect(reading.oiChangePct).toBeNull();
    expect(reading.direction).toBe('unknown');
    expect(reading.buildUp).toBeNull();
    expect(reading.rank).toBeNull();
  });

  it('keeps premium math when previous OI is absent but does not invent OI change', () => {
    const reading = strikeReadings(flow(contract(25_000, 'CE', [point(0, 105, 1_100)], { prevClose: 100, prevOi: null })), 'day')[0];

    expect(reading.premiumChangePct).toBe(5);
    expect(reading.oiChange).toBeNull();
    expect(reading.oiChangePct).toBeNull();
    expect(reading.buildUp).toBeNull();
  });

  it('does not label build-up when either OI baseline or current OI is zero', () => {
    const zeroBaseline = strikeReadings(flow(contract(25_000, 'CE', [point(0, 105, 20)], { prevClose: 100, prevOi: 0 })), 'day')[0];
    const zeroCurrent = strikeReadings(flow(contract(25_000, 'PE', [point(0, 95, 0)], { prevClose: 100, prevOi: 1_000 })), 'day')[0];

    expect(zeroBaseline.oiChange).toBe(20);
    expect(zeroBaseline.oiChangePct).toBeNull();
    expect(zeroBaseline.buildUp).toBeNull();
    expect(zeroCurrent.oiChange).toBe(-1_000);
    expect(zeroCurrent.buildUp).toBeNull();
  });

  it.each([
    { window: '5m', minutes: 5, buildUp: 'LONG_BUILD' },
    { window: '15m', minutes: 15, buildUp: 'LONG_BUILD' },
    { window: '1h', minutes: 60, buildUp: 'NEUTRAL' },
  ] as const)('uses the $window lookback and classifier floor', ({ window, minutes, buildUp }) => {
    const item = contract(25_000, 'CE', [point(0, 100, 1_000), point(minutes, 100.6, 1_015)]);
    const reading = strikeReadings(flow(item), window satisfies StrikeFlowWindow)[0];

    expect(reading.premiumChangePct).toBeCloseTo(0.6);
    expect(reading.premiumBaselineAt).toBe(BASE_AT + MINUTE);
    expect(reading.oiChangePct).toBeCloseTo(1.5);
    expect(reading.buildUp).toBe(buildUp);
  });

  it('uses the nearest in-tolerance minute and rejects a seven-minute gap for 5m', () => {
    const inWindow = contract(25_000, 'CE', [point(0, 90, 900), point(5, 100, 1_000), point(10, 110, 1_020)]);
    const reading = strikeReadings(flow(inWindow), '5m')[0];
    expect(reading.premiumChange).toBe(10);
    expect(reading.premiumChangePct).toBe(10);
    expect(reading.oiChange).toBe(20);

    const gap = contract(25_000, 'PE', [point(0, 100, 1_000), point(7, 110, 1_100)]);
    const noBaseline = strikeReadings(flow(gap), '5m')[0];
    expect(noBaseline.premiumChangePct).toBeNull();
    expect(noBaseline.oiChange).toBeNull();
    expect(noBaseline.buildUp).toBeNull();
  });

  it('keeps sub-floor premium changes flat and uses the scanner neutral wording', () => {
    const item = contract(25_000, 'CE', [point(0, 100, 1_000), point(5, 100.4, 1_100)]);
    const reading = strikeReadings(flow(item), '5m')[0];

    expect(reading.direction).toBe('flat');
    expect(reading.buildUp).toBe('NEUTRAL');
    expect(buildUpWord(reading.buildUp)).toBe('No clear pattern');
  });

  it('ranks absolute premium changes and filters CE/PE without changing the readings', () => {
    const call = contract(25_000, 'CE', [point(0, 102, 1_100)], { prevClose: 100 });
    const put = contract(24_900, 'PE', [point(0, 90, 1_100)], { prevClose: 100 });
    const unmeasured = contract(25_100, 'CE', [point(0, 110, 1_100)], { prevClose: null });
    const readings = strikeReadings(flow(call, put, unmeasured), 'day');

    expect(readings.map(reading => [reading.strike, reading.rank])).toEqual([[24_900, 1], [25_000, 2], [25_100, null]]);
    expect(filterStrikeReadings(readings, 'all')).toEqual(readings);
    expect(filterStrikeReadings(readings, 'CE').map(reading => reading.strike)).toEqual([25_000, 25_100]);
    expect(filterStrikeReadings(readings, 'PE').map(reading => reading.strike)).toEqual([24_900]);
  });
});
