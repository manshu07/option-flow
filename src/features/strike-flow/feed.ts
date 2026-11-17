const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export type StrikeSide = 'CE' | 'PE';
export type StrikeSpotPoint = readonly [at: number, spot: number];
export type StrikeSeriesPoint = readonly [at: number, ltp: number, oi: number | null, volume: number | null, iv?: number | null];

export interface StrikeFlowContract {
  symbol: string;
  strike: number;
  side: StrikeSide;
  expiry: string | null;
  prevClose: number | null;
  prevOi: number | null;
  ltp: number | null;
  oi: number | null;
  volume: number | null;
  /** Captured vendor IV in percent at the latest point (schema row index 9). */
  iv?: number | null;
  spotDistancePct: number | null;
  series: StrikeSeriesPoint[];
}

export interface StrikeFlowPayload {
  /** Every underlying the payload carries (one for a single chain, three for All 3 Indices). */
  symbols: string[];
  /** Back-compat alias for the first symbol. */
  symbol: string;
  date: string;
  expiry: Record<string, string | null> | null;
  spotPrevClose: Record<string, number | null>;
  spot: Record<string, StrikeSpotPoint[]>;
  strikes: Record<string, StrikeFlowContract>;
  minuteCount: number;
}

export interface FetchStrikeFlowOptions {
  date: string;
  asOf?: string;
  signal?: AbortSignal;
  force?: boolean;
}

export interface FetchStrikeFlowsResult {
  payloads: StrikeFlowPayload[];
  unavailableSymbols: string[];
  failedSymbols: string[];
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
  return Array.isArray(value) && (value.length === 4 || value.length === 5) && isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && value[1] >= 0 &&
    isNullableNonNegative(value[2]) && isNullableNonNegative(value[3]) && (value.length === 4 || isNullableFinite(value[4]));
}

const CACHE_TTL_MS = 20_000;
const CACHE_LIMIT = 48;
const strikeFlowCache = new Map<string, { payload: StrikeFlowPayload; expiresAt: number }>();

const cacheKey = (symbol: string, date: string, asOf?: string) => `${date}|${symbol}|${asOf ?? ''}`;

function cachedStrikeFlow(symbol: string, { date, asOf, force }: FetchStrikeFlowOptions): StrikeFlowPayload | null {
  if (force) return null;
  const key = cacheKey(symbol, date, asOf);
  const entry = strikeFlowCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    strikeFlowCache.delete(key);
    return null;
  }
  strikeFlowCache.delete(key);
  strikeFlowCache.set(key, entry);
  return entry.payload;
}

function rememberStrikeFlow(payload: StrikeFlowPayload, asOf?: string): void {
  if (Object.keys(payload.strikes).length === 0) return;
  const key = cacheKey(payload.symbol, payload.date, asOf);
  strikeFlowCache.delete(key);
  strikeFlowCache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  while (strikeFlowCache.size > CACHE_LIMIT) strikeFlowCache.delete(strikeFlowCache.keys().next().value!);
}

function cleanSpotPoints(value: unknown): StrikeSpotPoint[] {
  return Array.isArray(value) ? value.filter(isSpotPoint) : [];
}

function nullableClose(value: unknown): number | null {
  return isNullableNonNegative(value) ? value : null;
}

function parseStrikeContract(value: unknown, symbol: string, fallbackExpiry: string | null): StrikeFlowContract | null {
  if (!isRecord(value)) return null;
  const rowSymbol = typeof value.symbol === 'string' ? value.symbol : symbol;
  if (rowSymbol !== symbol || !isFiniteNumber(value.strike) || value.strike <= 0 || (value.side !== 'CE' && value.side !== 'PE')) return null;
  const series = Array.isArray(value.series) ? value.series.filter(isSeriesPoint) : [];
  if (series.length === 0) return null;
  const last = series.at(-1)!;
  const expiry = value.expiry === null || typeof value.expiry === 'string' ? value.expiry : fallbackExpiry;
  return {
    symbol,
    strike: value.strike,
    side: value.side,
    expiry,
    prevClose: nullableClose(value.prevClose),
    prevOi: nullableClose(value.prevOi),
    ltp: nullableClose(value.ltp) ?? last[1],
    oi: nullableClose(value.oi) ?? last[2],
    volume: nullableClose(value.volume) ?? last[3],
    iv: isNullableFinite(value.iv) ? value.iv : last[4] ?? null,
    spotDistancePct: isNullableFinite(value.spotDistancePct) ? value.spotDistancePct : null,
    series,
  };
}

function parseStrikeFlowPayload(value: unknown, symbol: string): StrikeFlowPayload | null {
  if (!isRecord(value) || typeof value.date !== 'string' || !Number.isInteger(value.minuteCount) ||
    (value.minuteCount as number) < 0 || !isRecord(value.strikes)) return null;

  const multi = Array.isArray(value.symbols) && value.symbols.every(item => typeof item === 'string') && isRecord(value.spot);
  if (multi && !(value.symbols as string[]).includes(symbol)) return null;
  if (!multi && typeof value.symbol === 'string' && value.symbol !== symbol) return null;

  const spotValue = multi ? (value.spot as Record<string, unknown>)[symbol] : value.spot;
  const spot = cleanSpotPoints(spotValue);
  const prevCloseSource = value.spotPrevClose;
  const expirySource = value.expiry;
  const spotPrevClose = isRecord(prevCloseSource) ? nullableClose(prevCloseSource[symbol]) : nullableClose(prevCloseSource);
  const expiryValue = isRecord(expirySource) ? expirySource[symbol] : expirySource;
  const expiry = expiryValue === null || typeof expiryValue === 'string' ? expiryValue : null;
  const strikes: Record<string, StrikeFlowContract> = {};

  for (const [key, row] of Object.entries(value.strikes)) {
    const keyParts = key.split('|');
    const keySymbol = keyParts.length >= 3 ? keyParts[0] : symbol;
    if (keySymbol !== symbol) continue;
    const contract = parseStrikeContract(row, symbol, expiry);
    if (contract) strikes[`${symbol}|${contract.strike}|${contract.side}`] = contract;
  }

  return {
    symbols: [symbol],
    symbol,
    date: value.date,
    expiry: { [symbol]: expiry },
    spotPrevClose: { [symbol]: spotPrevClose },
    spot: { [symbol]: spot },
    strikes,
    minuteCount: value.minuteCount as number,
  };
}

async function requestStrikeJson(symbols: string[], { date, asOf, signal }: FetchStrikeFlowOptions): Promise<{ status: number; ok: boolean; body: unknown }> {
  const query = new URLSearchParams({ date });
  if (asOf) query.set('asOf', asOf);
  // Keep the comma between validated symbols literal for the server's scope route.
  const path = symbols.map(symbol => encodeURIComponent(symbol)).join(',');
  const response = await fetch(`${API}/api/strikes/${path}?${query}`, { cache: 'no-store', signal });
  const body = response.ok ? await response.json().catch(() => null) : null;
  return { status: response.status, ok: response.ok, body };
}

function payloadHasContracts(payload: StrikeFlowPayload | null): payload is StrikeFlowPayload {
  return payload !== null && Object.keys(payload.strikes).length > 0;
}

/** One symbol fetch, normalized from either the original flat response or the newer symbol-map response. */
export async function fetchStrikeFlow(symbol: string, options: FetchStrikeFlowOptions): Promise<StrikeFlowPayload | null> {
  const cached = cachedStrikeFlow(symbol, options);
  if (cached) return cached;
  const response = await requestStrikeJson([symbol], options);
  if (response.status === 404 || response.status === 503) return null;
  if (!response.ok) throw new Error(`Strike flow ${symbol}: ${response.status}`);
  const payload = parseStrikeFlowPayload(response.body, symbol);
  if (payloadHasContracts(payload)) rememberStrikeFlow(payload, options.asOf);
  return payload;
}

/** Fetch a scope in one request where supported; cache per symbol and fall back safely to older single-symbol servers. */
export async function fetchStrikeFlows(symbols: string[], options: FetchStrikeFlowOptions): Promise<FetchStrikeFlowsResult> {
  const requested = [...new Set(symbols)];
  const payloadBySymbol = new Map<string, StrikeFlowPayload>();
  const failed = new Set<string>();
  // Force skips the client cache entirely; otherwise every requested symbol starts from its cached payload.
  const cached = options.force ? [] : requested.map(symbol => [symbol, cachedStrikeFlow(symbol, options)] as const);
  for (const [symbol, payload] of cached) if (payload) payloadBySymbol.set(symbol, payload);
  let missing = requested.filter(symbol => !payloadBySymbol.has(symbol));

  if (missing.length > 1) {
    try {
      const response = await requestStrikeJson(missing, options);
      if (response.status === 404 || response.status === 503) {
        missing = missing;
      } else if (!response.ok && response.status !== 400) {
        missing = missing;
      } else if (response.ok) {
        const batch = isRecord(response.body) && Array.isArray(response.body.symbols) && isRecord(response.body.spot);
        const parsed = missing.map(symbol => [symbol, parseStrikeFlowPayload(response.body, symbol)] as const);
        for (const [symbol, payload] of parsed) {
          if (!payloadHasContracts(payload)) continue;
          payloadBySymbol.set(symbol, payload);
          rememberStrikeFlow(payload, options.asOf);
        }
        missing = missing.filter(symbol => !payloadBySymbol.has(symbol) && (!batch || !(response.body as Record<string, unknown>).symbols || !((response.body as { symbols: string[] }).symbols.includes(symbol))));
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // A legacy single-symbol route may reject the comma scope; retry each symbol below.
    }
  }

  if (missing.length) {
    const settled = await Promise.allSettled(missing.map(symbol => fetchStrikeFlow(symbol, { ...options, force: true })));
    settled.forEach((result, index) => {
      const symbol = missing[index]!;
      if (result.status === 'rejected') {
        if (options.signal?.aborted) return;
        failed.add(symbol);
        return;
      }
      if (!payloadHasContracts(result.value)) return;
      payloadBySymbol.set(symbol, result.value);
      rememberStrikeFlow(result.value, options.asOf);
    });
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  return {
    payloads: requested.map(symbol => payloadBySymbol.get(symbol)).filter((payload): payload is StrikeFlowPayload => payload !== undefined),
    unavailableSymbols: requested.filter(symbol => !payloadBySymbol.has(symbol) && !failed.has(symbol)),
    failedSymbols: requested.filter(symbol => failed.has(symbol)),
  };
}
