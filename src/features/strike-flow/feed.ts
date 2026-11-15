const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export type StrikeSide = 'CE' | 'PE';
export type StrikeSpotPoint = readonly [at: number, spot: number];
export type StrikeSeriesPoint = readonly [at: number, ltp: number, oi: number | null, volume: number | null];

export interface StrikeFlowContract {
  strike: number;
  side: StrikeSide;
  expiry: string | null;
  prevClose: number | null;
  prevOi: number | null;
  ltp: number | null;
  oi: number | null;
  volume: number | null;
  spotDistancePct: number | null;
  series: StrikeSeriesPoint[];
}

export interface StrikeFlowPayload {
  symbol: string;
  date: string;
  expiry: string | null;
  spot: StrikeSpotPoint[];
  strikes: Record<string, StrikeFlowContract>;
  minuteCount: number;
}

export interface FetchStrikeFlowOptions {
  date: string;
  asOf?: string;
  signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNullableFinite = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

const isNullableNonNegative = (value: unknown): value is number | null =>
  value === null || (isFiniteNumber(value) && value >= 0);

function isSpotPoint(value: unknown): value is StrikeSpotPoint {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && value[1] > 0;
}

function isSeriesPoint(value: unknown): value is StrikeSeriesPoint {
  return Array.isArray(value) && value.length === 4 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && value[1] >= 0 &&
    isNullableNonNegative(value[2]) && isNullableNonNegative(value[3]);
}

function isStrikeFlowContract(value: unknown): value is StrikeFlowContract {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.strike) && value.strike > 0 && (value.side === 'CE' || value.side === 'PE') &&
    (value.expiry === null || typeof value.expiry === 'string') && isNullableNonNegative(value.prevClose) &&
    isNullableNonNegative(value.prevOi) && isNullableNonNegative(value.ltp) && isNullableNonNegative(value.oi) &&
    isNullableNonNegative(value.volume) && isNullableFinite(value.spotDistancePct) && Array.isArray(value.series) &&
    value.series.every(isSeriesPoint);
}

function parseStrikeFlowPayload(value: unknown): StrikeFlowPayload | null {
  if (!isRecord(value) || typeof value.symbol !== 'string' || typeof value.date !== 'string' ||
    !(value.expiry === null || typeof value.expiry === 'string') || !Number.isInteger(value.minuteCount) ||
    (value.minuteCount as number) < 0 || !Array.isArray(value.spot) || !value.spot.every(isSpotPoint) || !isRecord(value.strikes)) {
    return null;
  }
  if (!Object.values(value.strikes).every(isStrikeFlowContract)) return null;
  return value as unknown as StrikeFlowPayload;
}

/** Read one captured chain. Closed or unavailable archive sessions are an empty result, not an exception. */
export async function fetchStrikeFlow(symbol: string, { date, asOf, signal }: FetchStrikeFlowOptions): Promise<StrikeFlowPayload | null> {
  const query = new URLSearchParams({ date });
  if (asOf) query.set('asOf', asOf);
  const response = await fetch(`${API}/api/strikes/${encodeURIComponent(symbol)}?${query}`, { cache: 'no-store', signal });
  if (response.status === 404 || response.status === 503) return null;
  if (!response.ok) throw new Error(`Strike flow ${symbol}: ${response.status}`);
  return parseStrikeFlowPayload(await response.json().catch(() => null));
}
