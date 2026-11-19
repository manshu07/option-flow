/**
 * Bar DNA — resample 1-minute history into larger timeframes, encode each bar
 * as a small token, and measure what actually follows a given token sequence.
 *
 * The owner's question: "find a pattern; when it happens the stock moves a
 * fixed % on one side". Nothing in a market is 100%, so the honest version is:
 * for every pattern, count how often the next `horizon` bars reached +X% or
 * −X%, with the sample size and a confidence floor, and check it on years the
 * pattern was not learned from. A pattern that only works in-sample is noise.
 *
 * Pure functions here; the CSV streaming lives in scripts/minePatterns.mjs.
 */

const MINUTE = 60_000;

/** Session-anchored resample: bars start at 09:15 and every `minutes` after it. */
export function resample(bars, minutes) {
  if (!(minutes > 0) || !Array.isArray(bars) || !bars.length) return [];
  const out = [];
  let current = null;
  for (const bar of bars) {
    if (!Number.isFinite(bar?.at) || !Number.isFinite(bar.close)) continue;
    const bucket = Math.floor(bar.at / (minutes * MINUTE)) * minutes * MINUTE;
    if (!current || current.at !== bucket) {
      if (current) out.push(current);
      current = { at: bucket, open: bar.open ?? bar.close, high: bar.high ?? bar.close, low: bar.low ?? bar.close, close: bar.close, volume: bar.volume ?? 0 };
      continue;
    }
    current.high = Math.max(current.high, bar.high ?? bar.close);
    current.low = Math.min(current.low, bar.low ?? bar.close);
    current.close = bar.close;
    current.volume += bar.volume ?? 0;
  }
  if (current) out.push(current);
  return out;
}

/**
 * One bar as a 4-character token: direction, body size vs ATR, where it closed
 * inside its range, and volume vs its recent average. Small enough that a
 * 3-bar sequence still has hundreds of samples, rich enough to describe shape.
 */
export function barToken(bar, { atr, avgVolume, alphabet = 'full' }) {
  const open = bar.open ?? bar.close;
  const close = bar.close;
  const high = Number.isFinite(bar.high) ? bar.high : close;
  const low = Number.isFinite(bar.low) ? bar.low : close;
  const dir = close > open ? 'U' : close < open ? 'D' : 'F';
  const body = Math.abs(close - open);
  const size = !(atr > 0) ? 1 : body < atr * 0.25 ? 0 : body < atr * 0.6 ? 1 : body < atr * 1.2 ? 2 : 3;
  const span = high - low;
  const place = span <= 0 ? 1 : (close - low) / span;
  const loc = place < 0.34 ? 'L' : place > 0.66 ? 'H' : 'M';
  const vol = !(avgVolume > 0) ? 1 : bar.volume < avgVolume * 0.7 ? 0 : bar.volume < avgVolume * 1.5 ? 1 : 2;
  if (alphabet === 'dir') return dir;
  if (alphabet === 'shape') return `${dir}${size}${loc}`;
  if (alphabet === 'body') return `${dir}${size}`;
  return `${dir}${size}${loc}${vol}`;
}

/** Rolling ATR and average volume over `period` bars, aligned to each index. */
export function rollingContext(bars, period = 14) {
  const atr = new Array(bars.length).fill(null);
  const avgVolume = new Array(bars.length).fill(null);
  let trSum = 0;
  let volSum = 0;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevClose = i > 0 ? bars[i - 1].close : bar.open ?? bar.close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    trSum += tr;
    volSum += bar.volume ?? 0;
    if (i >= period) {
      const old = bars[i - period];
      const oldPrev = i - period > 0 ? bars[i - period - 1].close : old.open ?? old.close;
      trSum -= Math.max(old.high - old.low, Math.abs(old.high - oldPrev), Math.abs(old.low - oldPrev));
      volSum -= old.volume ?? 0;
    }
    if (i >= period - 1) {
      atr[i] = trSum / period;
      avgVolume[i] = volSum / period;
    }
  }
  return { atr, avgVolume };
}

/** Wilson score interval — the floor a hit rate can claim at 95% confidence. */
export function wilsonLower(hits, total, z = 1.96) {
  if (!(total > 0)) return 0;
  const p = hits / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (centre - spread) / denom);
}

/**
 * Scan a token sequence for what followed it.
 *
 * For every index with `lookback` tokens of history and `horizon` bars of
 * future, record whether the future reached +target% (up) or −target% (down)
 * from that bar's close. Returns per-pattern counts plus the unconditional
 * baseline, so a pattern is only interesting if it beats the baseline.
 */
export function minePatterns(bars, { lookback = 3, horizon = 3, targetPct = 1, splitAt = null, period = 14, alphabet = 'full' } = {}) {
  const { atr, avgVolume } = rollingContext(bars, period);
  const tokens = bars.map((bar, i) => barToken(bar, { atr: atr[i], avgVolume: avgVolume[i], alphabet }));
  const patterns = new Map();
  const base = { train: { n: 0, up: 0, down: 0 }, test: { n: 0, up: 0, down: 0 } };
  for (let i = period + lookback - 1; i + horizon < bars.length; i++) {
    const bar = bars[i];
    // Never let a pattern straddle two sessions.
    if (bars[i + horizon].session && bar.session && bars[i + horizon].session !== bar.session) continue;
    const key = tokens.slice(i - lookback + 1, i + 1).join(' ');
    const close = bar.close;
    if (!(close > 0)) continue;
    let hi = close;
    let lo = close;
    for (let k = i + 1; k <= i + horizon; k++) {
      if (bars[k].session && bar.session && bars[k].session !== bar.session) { hi = NaN; break; }
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
    }
    if (!Number.isFinite(hi)) continue;
    const up = (hi / close - 1) * 100 >= targetPct;
    const down = (1 - lo / close) * 100 >= targetPct;
    const split = splitAt && bar.session ? (bar.session < splitAt ? 'train' : 'test') : 'train';
    let entry = patterns.get(key);
    if (!entry) {
      entry = { pattern: key, train: { n: 0, up: 0, down: 0 }, test: { n: 0, up: 0, down: 0 } };
      patterns.set(key, entry);
    }
    entry[split].n++;
    if (up) entry[split].up++;
    if (down) entry[split].down++;
    base[split].n++;
    if (up) base[split].up++;
    if (down) base[split].down++;
  }
  return { patterns: [...patterns.values()], base };
}

/** Rank patterns by the confidence floor of their better side, with a sample floor. */
export function rankPatterns(result, { minSamples = 100, side = 'auto' } = {}) {
  const rows = [];
  for (const entry of result.patterns) {
    const t = entry.train;
    if (t.n < minSamples) continue;
    const upRate = t.up / t.n;
    const downRate = t.down / t.n;
    const dir = side === 'auto' ? (upRate >= downRate ? 'up' : 'down') : side;
    const hits = dir === 'up' ? t.up : t.down;
    const test = entry.test;
    const testHits = dir === 'up' ? test.up : test.down;
    rows.push({
      pattern: entry.pattern,
      direction: dir,
      samples: t.n,
      hitRate: hits / t.n,
      floor: wilsonLower(hits, t.n),
      testSamples: test.n,
      testHitRate: test.n ? testHits / test.n : null,
      testFloor: test.n ? wilsonLower(testHits, test.n) : null,
    });
  }
  rows.sort((a, b) => b.floor - a.floor || b.samples - a.samples);
  return rows;
}