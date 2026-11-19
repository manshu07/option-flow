/**
 * Regime classification — trend up, trend down, or range, from the sessions
 * BEFORE the entry (never the entry day itself, which would be lookahead).
 *
 * Efficiency ratio = |net change over N sessions| / sum of |daily changes|.
 * A clean trend approaches 1; a choppy range approaches 0.
 */
export const REGIME_LOOKBACK = 10;
export const REGIME_TREND_ER = 0.35;
export const REGIMES = ['up', 'down', 'range'];

export function regimeOf(closes, index, lookback = REGIME_LOOKBACK) {
  if (!Array.isArray(closes) || index < lookback || index > closes.length) return 'range';
  const start = closes[index - lookback];
  const end = closes[index - 1];
  if (!(start > 0 && end > 0)) return 'range';
  let path = 0;
  for (let i = index - lookback + 1; i < index; i++) path += Math.abs(closes[i] - closes[i - 1]);
  if (!(path > 0)) return 'range';
  const er = Math.abs(end - start) / path;
  if (er < REGIME_TREND_ER) return 'range';
  return end > start ? 'up' : 'down';
}

/** The regime right now, from a stats file's trailing closes plus today's price. */
export function liveRegime(recentCloses, livePrice = null) {
  const closes = (Array.isArray(recentCloses) ? recentCloses : [])
    .map(item => Number(item?.close ?? item))
    .filter(value => Number.isFinite(value) && value > 0);
  if (Number.isFinite(livePrice) && livePrice > 0) closes.push(livePrice);
  return regimeOf(closes, closes.length);
}