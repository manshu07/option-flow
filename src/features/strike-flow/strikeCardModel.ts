import { BUILD_UP_NOISE_FLOOR, type BuildUpWindow } from '@/lib/buildUp';
import { SCAN_WINDOW_MINUTES, SCAN_WINDOW_TOLERANCE_MS, type IntradayWindow } from '../options-scanner/contractScanModel';
import type { StrikeFlowPayload } from './feed';
import type { StrikeFlowWindow, StrikeReading } from './strikeFlowModel';

export type StrikeCardCheckId = 'premium' | 'oi' | 'volume' | 'distance' | 'spot';

export interface StrikeCardCheck {
  id: StrikeCardCheckId;
  label: string;
  pass: boolean | null;
  note: string;
}

export interface StrikeWall {
  strike: number;
  oi: number;
}

export interface StrikeWalls {
  support: StrikeWall | null;
  resistance: StrikeWall | null;
}

export interface StrikePremiumZone {
  low: number;
  high: number;
}

const MINUTE = 60_000;
const SPOT_DISTANCE_LIMIT_PCT = 5;
const BUILD_UP_WINDOW: Record<StrikeFlowWindow, BuildUpWindow> = { day: '1d', '1h': '1h', '15m': '15m', '5m': '5m' };

export function strikeWalls(flow: StrikeFlowPayload, spot = flow.spot.at(-1)?.[1] ?? null): StrikeWalls {
  if (spot === null || !Number.isFinite(spot) || spot <= 0) return { support: null, resistance: null };
  const byStrike = new Map<number, { call: number; put: number }>();
  for (const contract of Object.values(flow.strikes)) {
    if (contract.oi === null || !Number.isFinite(contract.oi) || contract.oi <= 0) continue;
    const level = byStrike.get(contract.strike) ?? { call: 0, put: 0 };
    if (contract.side === 'CE') level.call += contract.oi;
    else level.put += contract.oi;
    byStrike.set(contract.strike, level);
  }

  const nearestHeavy = (side: 'call' | 'put', predicate: (strike: number) => boolean): StrikeWall | null => {
    const candidates = [...byStrike.entries()]
      .filter(([strike, levels]) => predicate(strike) && levels[side] > 0)
      .map(([strike, levels]) => ({ strike, oi: levels[side] }));
    candidates.sort((a, b) => b.oi - a.oi || Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike);
    return candidates[0] ?? null;
  };

  return {
    support: nearestHeavy('put', strike => strike < spot),
    resistance: nearestHeavy('call', strike => strike > spot),
  };
}

export function spotChangeForWindow(flow: StrikeFlowPayload, window: StrikeFlowWindow): number | null {
  const current = flow.spot.at(-1);
  if (!current || current[1] <= 0) return null;
  if (window === 'day') {
    return flow.spotPrevClose !== null && flow.spotPrevClose > 0
      ? (current[1] / flow.spotPrevClose - 1) * 100
      : null;
  }

  const intradayWindow: IntradayWindow = window;
  const to = current[0] + MINUTE;
  const target = to - SCAN_WINDOW_MINUTES[intradayWindow] * MINUTE;
  let closest: (typeof flow.spot)[number] | null = null;
  let gap = Infinity;
  for (const point of flow.spot) {
    const end = point[0] + MINUTE;
    if (end >= to) continue;
    const distance = Math.abs(end - target);
    if (distance < gap) { closest = point; gap = distance; }
  }
  if (!closest || gap > SCAN_WINDOW_TOLERANCE_MS[intradayWindow] || closest[1] <= 0) return null;
  return (current[1] / closest[1] - 1) * 100;
}

export function strikePremiumZone(reading: StrikeReading, window: StrikeFlowWindow): StrikePremiumZone | null {
  const points = reading.series.filter(point => {
    if (window === 'day') return true;
    return reading.premiumBaselineAt !== null && point[0] + MINUTE >= reading.premiumBaselineAt;
  });
  if (!points.length) return null;
  const prices = points.map(point => point[1]);
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

export function strikeCardChecks(reading: StrikeReading, spotChangePct: number | null, window: StrikeFlowWindow): StrikeCardCheck[] {
  const floor = BUILD_UP_NOISE_FLOOR[BUILD_UP_WINDOW[window]];
  const premiumPass = reading.premiumChangePct === null
    ? null
    : Math.abs(reading.premiumChangePct) >= floor.pricePct;
  const oiPass = reading.oiChangePct === null
    ? null
    : Math.abs(reading.oiChangePct) >= floor.oiPct;
  const volumePass = reading.volumePace === null ? null : reading.volumePace > 0;
  const distancePass = reading.spotDistancePct === null
    ? null
    : Math.abs(reading.spotDistancePct) <= SPOT_DISTANCE_LIMIT_PCT;
  const premiumSign = Math.sign(reading.premiumChangePct ?? 0);
  const underlyingSign = Math.sign(spotChangePct ?? 0);
  const sideAdjustedPremiumSign = premiumSign * (reading.side === 'CE' ? 1 : -1);
  const spotPass = premiumChangePctIsMeasured(reading.premiumChangePct) && spotChangePct !== null && underlyingSign !== 0
    ? sideAdjustedPremiumSign === underlyingSign
    : null;

  return [
    { id: 'premium', label: 'Premium window move', pass: premiumPass, note: reading.premiumChangePct === null ? 'No premium baseline' : `Floor ${floor.pricePct}%` },
    { id: 'oi', label: 'OI window move', pass: oiPass, note: reading.oiChangePct === null ? 'No OI baseline' : `Floor ${floor.oiPct}%` },
    { id: 'volume', label: 'Volume pace', pass: volumePass, note: reading.volumePace === null ? 'No captured volume delta' : `${reading.volumePace.toFixed(1)} contracts/min` },
    { id: 'distance', label: 'Distance-from-spot sanity', pass: distancePass, note: reading.spotDistancePct === null ? 'No spot distance' : `${Math.abs(reading.spotDistancePct).toFixed(2)}% · max ${SPOT_DISTANCE_LIMIT_PCT}%` },
    { id: 'spot', label: 'Spot-direction agreement', pass: spotPass, note: spotChangePct === null ? 'No spot baseline' : `${spotChangePct > 0 ? '+' : ''}${spotChangePct.toFixed(2)}% spot move` },
  ];
}

function premiumChangePctIsMeasured(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value !== 0;
}
