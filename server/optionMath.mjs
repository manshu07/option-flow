/**
 * Option maths for card levels — targets come from an underlying move, net of
 * decay, and every premium level carries the stock price it needs.
 *
 * The owner's rule: a premium percentage means nothing on its own. "TGT1 +55%"
 * is only a real target if the stock can actually reach the price that implies
 * after theta. So levels are sized on the underlying (ATR), converted with
 * delta + gamma − theta, and the required stock level is printed beside them.
 *
 *   ΔPremium ≈ |delta|·ΔS + ½·gamma·ΔS² + thetaPerDay·days
 *
 * ΔS is positive in the trade's favour (up for a CE, down for a PE).
 */
import { ivFor } from '../src/features/market-flow/gammaModel.ts';

const DAY_MS = 86_400_000;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const pdf = x => Math.exp(-x * x / 2) / SQRT_2PI;

/** Abramowitz–Stegun 7.1.26 — accurate to ~1e-7, plenty for a normal CDF here. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const cdf = x => 0.5 * (1 + erf(x / Math.SQRT2));

/** Years to the expiry's 15:30 IST close, floored at one hour. */
export function yearsToExpiry(expiry, now = Date.now()) {
  const close = Date.parse(`${expiry}T15:30:00+05:30`);
  if (!Number.isFinite(close)) return null;
  return Math.max(1 / (365 * 24), (close - now) / DAY_MS / 365);
}

/** Black-Scholes greeks for a European option; theta is per calendar day (negative). */
export function greeks({ spot, strike, years, iv, rate = 0.065, side }) {
  if (!(spot > 0 && strike > 0 && years > 0 && iv > 0)) return null;
  const rootT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + iv * iv / 2) * years) / (iv * rootT);
  const d2 = d1 - iv * rootT;
  const call = side === 'CE' || side === 0;
  const delta = call ? cdf(d1) : cdf(d1) - 1;
  const gamma = pdf(d1) / (spot * iv * rootT);
  const thetaYear = -(spot * pdf(d1) * iv) / (2 * rootT)
    - (call ? rate * strike * Math.exp(-rate * years) * cdf(d2) : -rate * strike * Math.exp(-rate * years) * cdf(-d2));
  return { delta, gamma, thetaDay: thetaYear / 365, vega: spot * pdf(d1) * rootT / 100 };
}

/**
 * The IV to price with: the captured feed IV when it is sane, else the gamma
 * engine's inversion of the premium itself. December legs often carry IV 0 —
 * a flat 30% guess would misprice every level, so it is never used.
 */
export function optionIv({ premium, spot, strike, years, rate = 0.065, side, captured = null }) {
  const feed = Number(captured);
  if (Number.isFinite(feed) && feed >= 5 && feed <= 150) return feed / 100; // captured IV is in percent
  const inverted = ivFor(premium, spot, strike, years, rate, side === 'PE' || side === 1 ? 1 : 0);
  return Number.isFinite(inverted) && inverted > 0 ? inverted : null;
}

/** Black-Scholes price of a European option. */
export function bsPrice({ spot, strike, years, iv, rate = 0.065, side }) {
  if (!(spot > 0 && strike > 0 && iv > 0)) return null;
  const call = side === 'CE' || side === 0;
  if (!(years > 0)) return Math.max(0, call ? spot - strike : strike - spot);
  const rootT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + iv * iv / 2) * years) / (iv * rootT);
  const d2 = d1 - iv * rootT;
  const disc = Math.exp(-rate * years);
  return call
    ? spot * cdf(d1) - strike * disc * cdf(d2)
    : strike * disc * cdf(-d2) - spot * cdf(-d1);
}

/**
 * The premium after the underlying reaches `level`, `days` later. Repricing
 * beats a delta/gamma expansion here: a multi-session ATR move is far too big
 * for a second-order Taylor term, which would price a stop ABOVE the entry.
 */
export function premiumAtLevel({ level, strike, years, iv, rate = 0.065, side, days = 0 }) {
  return bsPrice({ spot: level, strike, years: Math.max(1 / (365 * 24), years - days / 365), iv, rate, side });
}

/** The underlying level a premium target needs `days` out — bisection on the price curve. */
export function spotForPremium({ target, spot, strike, years, iv, rate = 0.065, side, days = 0 }) {
  if (!(target > 0 && spot > 0 && years > 0 && iv > 0)) return null;
  const call = side === 'CE' || side === 0;
  let low = call ? spot : spot * 0.2;
  let high = call ? spot * 3 : spot;
  const price = level => premiumAtLevel({ level, strike, years, iv, rate, side, days });
  const atLow = price(low);
  const atHigh = price(high);
  if (!(Number.isFinite(atLow) && Number.isFinite(atHigh))) return null;
  if (call ? atLow >= target : atLow <= target) return low;
  if (call ? atHigh < target : atHigh > target) return null; // unreachable inside 3x / 0.2x spot
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    const value = price(mid);
    if (!Number.isFinite(value)) return null;
    if (call ? value < target : value > target) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

/** Premium after a favourable (or adverse, when negative) underlying move and `days` of decay. */
export function premiumForMove({ entry, move, delta, gamma, thetaDay = 0, days = 0 }) {
  if (!(Number.isFinite(entry) && Number.isFinite(move) && Number.isFinite(delta))) return null;
  const d = Math.abs(delta);
  const g = Number.isFinite(gamma) ? gamma : 0;
  return entry + d * move + 0.5 * g * move * move + (Number.isFinite(thetaDay) ? thetaDay : 0) * days;
}

/**
 * The underlying move a premium target needs, decay included. Solves
 * ½γ·m² + |δ|·m + θ·days = target − entry for the positive root.
 */
export function requiredMove({ entry, target, delta, gamma, thetaDay = 0, days = 0 }) {
  if (!(Number.isFinite(entry) && Number.isFinite(target) && Number.isFinite(delta) && Math.abs(delta) > 0)) return null;
  const need = target - entry - (Number.isFinite(thetaDay) ? thetaDay : 0) * days;
  // Already there: decay alone leaves the premium at or above the target, so
  // no favourable move is required.
  if (need <= 0) return 0;
  const d = Math.abs(delta);
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : 0;
  if (g === 0) return need / d;
  const disc = d * d + 2 * g * need;
  if (disc < 0) return null;
  return (-d + Math.sqrt(disc)) / g;
}

/** The stock level a move implies, and its % distance from spot. */
export function levelFor({ spot, move, side }) {
  if (!(Number.isFinite(spot) && Number.isFinite(move))) return null;
  const level = side === 'PE' || side === 1 ? spot - move : spot + move;
  return { level, pct: spot > 0 ? (Math.abs(move) / spot) * 100 : null };
}