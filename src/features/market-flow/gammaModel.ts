/**
 * Captured-chain gamma estimate. Calls contribute positive GEX and puts
 * negative GEX: this is an assumption about dealer positioning, not a fact
 * that Open Interest can establish.
 *
 * OI is already in contracts, so the supplied lot size is metadata only and
 * is deliberately not multiplied into GEX. Feed IV is stored in percent and
 * normalized to a decimal volatility for Black-Scholes calculations.
 */

export type GammaSide = 'CE' | 'PE';
export type GammaRegime = 'gamma-long' | 'gamma-short';
export type GammaIvSource = 'feed' | 'inverted';

export interface GammaQuote {
  strike: number;
  side: GammaSide | 0 | 1;
  ltp: number;
  oi: number;
  iv?: number | null;
}

export interface GammaSeries {
  symbol?: string;
  /** Compact schema-1 names. */
  s?: string;
  t?: number;
  e?: string;
  sp?: number;
  /** Parsed market-file names. */
  at?: number;
  expiry?: string;
  spot?: number;
  lot?: number;
  quotes?: readonly GammaQuote[];
  /** Raw schema-1 option rows; IV is field 9 (field 8 is average price). */
  r?: readonly (readonly unknown[])[];
}

export interface GammaStrike {
  K: number;
  side: GammaSide;
  iv: number;
  ivSource: GammaIvSource;
  gamma: number;
  gex: number;
  oi: number;
}

export interface GammaProfile {
  strikes: GammaStrike[];
  skipped: number;
  totalGex: number;
  flipLevel: number | null;
  regime: GammaRegime | null;
}

export interface GammaProfileOptions {
  lot?: number;
  r?: number;
}

const MIN_IV = 0.05;
const MAX_IV = 1.5;
const MIN_PREMIUM = 0.5;
const MIN_TIME_MS = 60 * 60_000;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function gammaRiskFreeRate(raw: unknown): number {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return finite(value) ? value : 0.065;
}

function environmentRate(): number {
  const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return gammaRiskFreeRate(runtime.process?.env?.GAMMA_RISK_FREE);
}

function sideOf(value: unknown): GammaSide | null {
  if (value === 'CE' || value === 0) return 'CE';
  if (value === 'PE' || value === 1) return 'PE';
  return null;
}

function normCdf(value: number): number {
  const abs = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * abs);
  const density = Math.exp(-0.5 * abs * abs) / SQRT_2PI;
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

function normPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / SQRT_2PI;
}

function noArbitrageFloor(spot: number, strike: number, time: number, rate: number, side: GammaSide): number {
  const discountedStrike = strike * Math.exp(-rate * time);
  return Math.max(0, side === 'CE' ? spot - discountedStrike : discountedStrike - spot);
}

function blackScholesPrice(spot: number, strike: number, time: number, rate: number, sigma: number, side: GammaSide): number {
  const rootTime = Math.sqrt(time);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * time) / (sigma * rootTime);
  const d2 = d1 - sigma * rootTime;
  const discountedStrike = strike * Math.exp(-rate * time);
  return side === 'CE'
    ? spot * normCdf(d1) - discountedStrike * normCdf(d2)
    : discountedStrike * normCdf(-d2) - spot * normCdf(-d1);
}

function bufferedFloorPasses(premium: number, spot: number, strike: number, time: number, rate: number, side: GammaSide): boolean {
  const floor = noArbitrageFloor(spot, strike, time, rate, side);
  return premium >= floor * 1.02;
}

/** Newton-Raphson implied volatility; return null outside the supported 5–150% range. */
export function ivFor(premium: number, spot: number, strike: number, time: number, rate: number, side: GammaSide | 0 | 1): number | null {
  const normalizedSide = sideOf(side);
  if (!normalizedSide || !finite(premium) || premium <= MIN_PREMIUM || !finite(spot) || spot <= 0
    || !finite(strike) || strike <= 0 || !finite(time) || time <= 0 || !finite(rate)) return null;
  if (!bufferedFloorPasses(premium, spot, strike, time, rate, normalizedSide)) return null;

  let low = MIN_IV;
  let high = MAX_IV;
  const minPrice = blackScholesPrice(spot, strike, time, rate, low, normalizedSide);
  const maxPrice = blackScholesPrice(spot, strike, time, rate, high, normalizedSide);
  const tolerance = Math.max(1e-8, spot * 1e-10);
  if (premium < minPrice - tolerance || premium > maxPrice + tolerance) return null;
  if (Math.abs(premium - minPrice) <= tolerance) return MIN_IV;
  if (Math.abs(premium - maxPrice) <= tolerance) return MAX_IV;

  let sigma = 0.3;
  for (let iteration = 0; iteration < 100; iteration++) {
    const rootTime = Math.sqrt(time);
    const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * time) / (sigma * rootTime);
    const price = blackScholesPrice(spot, strike, time, rate, sigma, normalizedSide);
    const error = price - premium;
    if (Math.abs(error) <= tolerance) return sigma >= MIN_IV && sigma <= MAX_IV ? sigma : null;

    if (error > 0) high = sigma;
    else low = sigma;
    const vega = spot * normPdf(d1) * rootTime;
    const newton = vega > 1e-12 ? sigma - error / vega : Number.NaN;
    sigma = Number.isFinite(newton) && newton > low && newton < high ? newton : (low + high) / 2;
  }
  return null;
}

function capturedIvPercent(quote: { iv?: number | null }): number | null {
  return finite(quote.iv) && quote.iv >= MIN_IV * 100 && quote.iv <= MAX_IV * 100 ? quote.iv : null;
}

function gammaRows(series: GammaSeries): Array<{ K: unknown; side: unknown; premium: unknown; oi: unknown; iv: unknown }> {
  if (Array.isArray(series.r)) {
    return series.r.map(row => ({ K: row[0], side: row[1], premium: row[2], oi: row[4], iv: row[9] }));
  }
  return (Array.isArray(series.quotes) ? series.quotes : []).map(quote => ({
    K: quote.strike, side: quote.side, premium: quote.ltp, oi: quote.oi, iv: quote.iv,
  }));
}

function captureTime(series: GammaSeries): number | null {
  return finite(series.t) ? series.t : finite(series.at) ? series.at : null;
}

function expiryDate(series: GammaSeries): string | null {
  const value = typeof series.e === 'string' ? series.e : series.expiry;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function timeToExpiry(series: GammaSeries): number | null {
  const capturedAt = captureTime(series);
  const expiry = expiryDate(series);
  if (capturedAt == null || !expiry) return null;
  const expiryAt = Date.parse(`${expiry}T15:30:00+05:30`);
  if (!Number.isFinite(expiryAt)) return null;
  return Math.max(MIN_TIME_MS, expiryAt - capturedAt) / YEAR_MS;
}

function gammaAt(spot: number, strike: number, time: number, rate: number, sigma: number): number {
  const rootTime = Math.sqrt(time);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * sigma * sigma) * time) / (sigma * rootTime);
  return normPdf(d1) / (spot * sigma * rootTime);
}

/**
 * Build a signed GEX profile from one captured option chain. `lot` is accepted
 * for callers' series context, but is not applied because OI is already units.
 */
export function gammaProfile(series: GammaSeries, { lot = series.lot ?? 1, r = environmentRate() }: GammaProfileOptions = {}): GammaProfile {
  void lot;
  const spot = finite(series.sp) ? series.sp : series.spot;
  const time = timeToExpiry(series);
  const rate = finite(r) ? r : 0.065;
  const sourceRows = gammaRows(series);
  const strikes: GammaStrike[] = [];
  let skipped = 0;
  if (!finite(spot) || spot <= 0 || time == null) return { strikes: [], skipped: sourceRows.length, totalGex: 0, flipLevel: null, regime: null };

  for (const row of sourceRows) {
    const side = sideOf(row.side);
    const strike = row.K;
    const premium = row.premium;
    const oi = row.oi;
    if (!side || !finite(strike) || strike <= 0 || !finite(premium) || premium <= MIN_PREMIUM || !finite(oi) || oi < 1
      || !bufferedFloorPasses(premium, spot, strike, time, rate, side)) {
      skipped++;
      continue;
    }

    const rawIv = capturedIvPercent({ iv: row.iv as number | null });
    const iv = rawIv == null ? ivFor(premium, spot, strike, time, rate, side) : rawIv / 100;
    if (iv == null || iv < MIN_IV || iv > MAX_IV) {
      skipped++;
      continue;
    }
    const gamma = gammaAt(spot, strike, time, rate, iv);
    const gex = gamma * oi * spot * spot * 0.01 * (side === 'CE' ? 1 : -1);
    if (!finite(gamma) || !finite(gex)) {
      skipped++;
      continue;
    }
    strikes.push({ K: strike, side, iv, ivSource: rawIv == null ? 'inverted' : 'feed', gamma, gex, oi });
  }

  strikes.sort((a, b) => a.K - b.K || (a.side === 'CE' ? -1 : 1));
  const byStrike = new Map<number, number>();
  for (const row of strikes) byStrike.set(row.K, (byStrike.get(row.K) ?? 0) + row.gex);
  let cumulative = 0;
  let previous = 0;
  let flipLevel: number | null = null;
  for (const [strike, netGex] of [...byStrike.entries()].sort((a, b) => a[0] - b[0])) {
    previous = cumulative;
    cumulative += netGex;
    if ((previous < 0 && cumulative >= 0) || (previous > 0 && cumulative <= 0)) {
      flipLevel = strike;
      break;
    }
  }
  const totalGex = strikes.reduce((sum, row) => sum + row.gex, 0);
  const regime: GammaRegime | null = flipLevel == null ? null : spot >= flipLevel ? 'gamma-long' : 'gamma-short';
  return { strikes, skipped, totalGex, flipLevel, regime };
}
