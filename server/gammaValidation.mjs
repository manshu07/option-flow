/**
 * Gamma validation — does a flip-level cross actually precede a move?
 *
 * The gamma rollout for stocks (S5) was gated on "a week of validation". Doing
 * that by eyeballing the board does not scale to 220 symbols, so this module
 * turns the question into numbers over data we already capture:
 *
 *   spot crosses the gamma flip level  →  did spot keep going that way?
 *
 * Pure: samples and futures points in, records out. No network, no timers.
 */

const MINUTE = 60_000;

/** A flip cross is only counted when the flip level exists and spot has moved. */
export function flipCrosses(samples, { minMovePct = 0 } = {}) {
  const valid = (samples ?? [])
    .filter(sample => Number.isFinite(sample?.at) && Number.isFinite(sample?.spot) && Number.isFinite(sample?.flip))
    .sort((a, b) => a.at - b.at);
  const crosses = [];
  let side = null; // 'above' | 'below' — which side of the flip spot was on
  for (let i = 0; i < valid.length; i++) {
    const sample = valid[i];
    const nextSide = sample.spot >= sample.flip ? 'above' : 'below';
    if (side == null) { side = nextSide; continue; }
    if (nextSide === side) continue;
    // The crossing is measured against the previous sample's spot so a spot
    // that merely printed at the level does not count as a cross.
    const previous = valid[i - 1];
    const movePct = previous && previous.spot > 0 ? ((sample.spot - previous.spot) / previous.spot) * 100 : 0;
    side = nextSide;
    if (Math.abs(movePct) < minMovePct) continue;
    crosses.push({ at: sample.at, direction: nextSide === 'above' ? 'up' : 'down', spot: sample.spot, flip: sample.flip, movePct, regime: sample.regime ?? null });
  }
  return crosses;
}

/**
 * Percentage move from `at` to each horizon, using captured futures closes.
 * A horizon whose minute was not captured (the gap is bigger than the sampling
 * tolerance) returns null — carrying the last price forward would quietly
 * pretend the move stayed flat.
 */
export function forwardReturns(points, at, spot, { horizons = [15, 30, 60], eod = true, toleranceMinutes = 6 } = {}) {
  const sorted = (points ?? [])
    .filter(point => Number.isFinite(point?.at) && Number.isFinite(point?.close))
    .sort((a, b) => a.at - b.at);
  const priceAt = target => {
    let found = null;
    for (const point of sorted) {
      if (point.at > target) break;
      found = point;
    }
    if (!found) return null;
    if (target - found.at > toleranceMinutes * MINUTE) return null;
    return found.close;
  };
  const out = {};
  for (const minutes of horizons) {
    const price = priceAt(at + minutes * MINUTE);
    out[`m${minutes}`] = Number.isFinite(price) && spot > 0 ? ((price - spot) / spot) * 100 : null;
  }
  if (eod) {
    const last = sorted.length ? sorted[sorted.length - 1].close : null;
    out.eod = Number.isFinite(last) && spot > 0 ? ((last - spot) / spot) * 100 : null;
  }
  return out;
}

/**
 * One symbol-day: every flip cross with its forward move and whether the move
 * followed the cross direction beyond `thresholdPct` by `windowMinutes`.
 */
export function evaluateCrosses({ symbol, samples, points, thresholdPct = 0.3, windowMinutes = 60, horizons }) {
  return flipCrosses(samples).map(cross => {
    const returns = forwardReturns(points, cross.at, cross.spot, horizons ? { horizons } : undefined);
    const value = returns[`m${windowMinutes}`];
    const signed = cross.direction === 'up' ? value : value == null ? null : -value;
    return {
      ...cross,
      symbol,
      returns,
      matchPct: signed,
      followed: signed != null && signed >= thresholdPct,
    };
  });
}

/** Aggregates for the report: hit rate first, then the honest denominators. */
export function summarize(records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const decided = list.filter(record => record.matchPct != null);
  const followed = decided.filter(record => record.followed);
  const avg = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const byDirection = direction => {
    const subset = decided.filter(record => record.direction === direction);
    return { crosses: subset.length, followed: subset.filter(record => record.followed).length, avgMatchPct: avg(subset.map(record => record.matchPct)) };
  };
  return {
    crosses: list.length,
    evaluated: decided.length,
    followed: followed.length,
    hitRate: decided.length ? followed.length / decided.length : null,
    avgMatchPct: avg(decided.map(record => record.matchPct)),
    up: byDirection('up'),
    down: byDirection('down'),
  };
}

/** Plain-English summary — the owner reads this, not a table of percentages. */
export function summaryLines(summary, { from, to, symbols } = {}) {
  const pct = value => (value == null ? 'n/a' : `${(value * 100).toFixed(0)}%`);
  const signed = value => (value == null ? 'n/a' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`);
  const lines = [
    `Gamma flip validation · ${from ?? '?'} → ${to ?? '?'} · ${symbols ?? '?'} symbol(s)`,
    `Flip crosses: ${summary.crosses} (evaluated ${summary.evaluated})`,
    `Followed the cross (≥0.3% in that direction within 60 min): ${summary.followed} → ${pct(summary.hitRate)}`,
    `Average move in the cross direction: ${signed(summary.avgMatchPct)}`,
    `Upside crossings: ${summary.up.crosses} · followed ${summary.up.followed} · avg ${signed(summary.up.avgMatchPct)}`,
    `Downside crossings: ${summary.down.crosses} · followed ${summary.down.followed} · avg ${signed(summary.down.avgMatchPct)}`,
  ];
  if (!summary.evaluated) lines.push('No cross could be evaluated — the captured futures window did not cover the horizons.');
  return lines;
}