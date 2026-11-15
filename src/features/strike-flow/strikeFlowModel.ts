import { BUILD_UP_NOISE_FLOOR, classify, type BuildUp, type BuildUpWindow } from '@/lib/buildUp';
import { SCAN_WINDOW_MINUTES, SCAN_WINDOW_TOLERANCE_MS, type IntradayWindow } from '../options-scanner/contractScanModel';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint, StrikeSide } from './feed';

export type StrikeFlowWindow = 'day' | '1h' | '15m' | '5m';
export type StrikeDirection = 'up' | 'flat' | 'down' | 'unknown';
export type StrikeSideFilter = 'all' | StrikeSide;

export interface StrikeReading {
  key: string;
  symbol: string;
  date: string;
  strike: number;
  side: StrikeSide;
  expiry: string | null;
  ltp: number | null;
  premiumChange: number | null;
  premiumChangePct: number | null;
  oi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  spotDistancePct: number | null;
  lastAt: number | null;
  series: StrikeSeriesPoint[];
  direction: StrikeDirection;
  buildUp: BuildUp | null;
  rank: number | null;
}

interface Baseline {
  ltp: number | null;
  oi: number | null;
  at: number | null;
}

const MINUTE = 60_000;
const BUILD_UP_WINDOW: Record<StrikeFlowWindow, BuildUpWindow> = { day: '1d', '1h': '1h', '15m': '15m', '5m': '5m' };

const finiteOrNull = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function validSeriesPoint(point: StrikeSeriesPoint): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] >= 0 &&
    (point[2] === null || (Number.isFinite(point[2]) && point[2] >= 0)) &&
    (point[3] === null || (Number.isFinite(point[3]) && point[3] >= 0));
}

function baselineFor(contract: StrikeFlowContract, series: StrikeSeriesPoint[], window: StrikeFlowWindow): Baseline | null {
  if (window === 'day') {
    return { ltp: finiteOrNull(contract.prevClose), oi: finiteOrNull(contract.prevOi), at: null };
  }

  const last = series.at(-1);
  if (!last) return null;

  const intradayWindow: IntradayWindow = window;
  const to = last[0] + MINUTE;
  const target = to - SCAN_WINDOW_MINUTES[intradayWindow] * MINUTE;
  let closest: StrikeSeriesPoint | null = null;
  let closestGap = Infinity;

  for (const point of series) {
    const end = point[0] + MINUTE;
    if (end >= to) continue;
    const gap = Math.abs(end - target);
    if (gap < closestGap) {
      closest = point;
      closestGap = gap;
    }
  }

  if (!closest || closestGap > SCAN_WINDOW_TOLERANCE_MS[intradayWindow]) return null;
  return { ltp: closest[1], oi: closest[2], at: closest[0] + MINUTE };
}

function directionFor(changePct: number | null, floorPct: number): StrikeDirection {
  if (changePct === null || !Number.isFinite(changePct)) return 'unknown';
  if (Math.abs(changePct) < floorPct || changePct === 0) return 'flat';
  return changePct > 0 ? 'up' : 'down';
}

function readingFor(flow: StrikeFlowPayload, contract: StrikeFlowContract, window: StrikeFlowWindow): StrikeReading {
  const series = contract.series.filter(validSeriesPoint).slice().sort((a, b) => a[0] - b[0]);
  const last = series.at(-1);
  const baseline = baselineFor(contract, series, window);
  const ltp = last?.[1] ?? null;
  const oi = last?.[2] ?? null;
  const volume = last?.[3] ?? null;
  const premiumChange = ltp !== null && baseline?.ltp !== null && baseline !== null ? ltp - baseline.ltp : null;
  const premiumChangePct = premiumChange !== null && baseline?.ltp !== null && baseline !== null && baseline.ltp > 0
    ? premiumChange / baseline.ltp * 100
    : null;
  const oiChange = oi !== null && baseline?.oi !== null && baseline !== null ? oi - baseline.oi : null;
  const oiChangePct = oiChange !== null && baseline?.oi !== null && baseline !== null && baseline.oi > 0
    ? oiChange / baseline.oi * 100
    : null;
  const timeframe = BUILD_UP_WINDOW[window];
  let buildUp: BuildUp | null = null;

  // A zero OI baseline/current reading is not enough evidence for a build-up label.
  if (baseline?.oi !== null && baseline !== null && baseline.oi > 0 && oi !== null && oi > 0 &&
    premiumChange !== null && premiumChangePct !== null && oiChange !== null && oiChangePct !== null) {
    buildUp = classify(premiumChange, oiChange, oiChangePct, baseline.oi, timeframe, premiumChangePct);
  }

  return {
    key: `${contract.strike}|${contract.side}`,
    symbol: flow.symbol,
    date: flow.date,
    strike: contract.strike,
    side: contract.side,
    expiry: contract.expiry,
    ltp,
    premiumChange,
    premiumChangePct,
    oi,
    oiChange,
    oiChangePct,
    volume,
    spotDistancePct: finiteOrNull(contract.spotDistancePct),
    lastAt: last?.[0] ?? null,
    series,
    direction: directionFor(premiumChangePct, BUILD_UP_NOISE_FLOOR[timeframe].pricePct),
    buildUp,
    rank: null,
  };
}

/** Measure each contract from its honest day or intraday baseline, then rank measurable moves. */
export function strikeReadings(flow: StrikeFlowPayload, window: StrikeFlowWindow): StrikeReading[] {
  const readings = Object.values(flow.strikes).map(contract => readingFor(flow, contract, window));
  readings.sort((a, b) => {
    if (a.premiumChangePct === null) return b.premiumChangePct === null ? a.strike - b.strike || a.side.localeCompare(b.side) : 1;
    if (b.premiumChangePct === null) return -1;
    return Math.abs(b.premiumChangePct) - Math.abs(a.premiumChangePct) || a.strike - b.strike || a.side.localeCompare(b.side);
  });

  let rank = 0;
  return readings.map(reading => ({
    ...reading,
    rank: reading.premiumChangePct === null ? null : ++rank,
  }));
}

export function filterStrikeReadings(readings: readonly StrikeReading[], side: StrikeSideFilter): StrikeReading[] {
  return side === 'all' ? [...readings] : readings.filter(reading => reading.side === side);
}
