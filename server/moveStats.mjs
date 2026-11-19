/**
 * Move statistics consumer — what this stock has actually done, so a card's
 * target is a level the stock reaches, not a percentage picked in the air.
 *
 * Source: the owner's 1-minute EQUITY history, ingested offline by
 * scripts/ingestMoveStats.mjs into server/data/move-stats/<SYM>.json.
 * These are SPOT statistics: stock options settle on spot, so they size option
 * levels. They are not futures statistics and must never be labelled as such.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const cache = new Map();

export function loadMoveStats(dir, symbol) {
  const key = `${dir}|${symbol}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(dir, `${symbol}.json`);
  let stats = null;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.instrument === 'EQ' && parsed.intraday && parsed.daily) stats = parsed;
    } catch { stats = null; }
  }
  cache.set(key, stats);
  return stats;
}

/** The nearest ingested entry time at or before `hhmm` (never a later one). */
export function entryBucket(stats, hhmm) {
  const times = Array.isArray(stats?.entryTimes) ? stats.entryTimes : [];
  let best = null;
  for (const time of times) if (time <= hhmm && (!best || time > best)) best = time;
  return best;
}

const nearestHold = (stats, days) => {
  const holds = Array.isArray(stats?.holds) ? stats.holds : [];
  if (!holds.length) return null;
  return holds.reduce((best, hold) => (Math.abs(hold - days) < Math.abs(best - days) ? hold : best), holds[0]);
};

/**
 * The move a target should ask for.
 *
 * `holdDays = 0` means "rest of today" (intraday); anything else uses the
 * multi-day distribution. Mind the direction of a percentile: **p30 is the
 * move 70% of past windows reached**, p70 is reached by only 30%.
 */
export function moveFor({ stats, hhmm, holdDays = 0, side = 'CE', percentile = 70, era = 'recent' }) {
  if (!stats) return null;
  const direction = side === 'PE' ? 'down' : 'up';
  const key = `p${percentile}`;
  if (holdDays <= 0) {
    const bucket = entryBucket(stats, hhmm);
    if (!bucket) return null;
    const set = stats.intraday?.[bucket]?.[era] ?? stats.intraday?.[bucket]?.all;
    const values = set?.[direction];
    if (!values || !Number.isFinite(values[key])) return null;
    return { pct: values[key], samples: values.n, basis: 'intraday', bucket, era, percentile, instrument: stats.instrument };
  }
  const hold = nearestHold(stats, holdDays);
  const set = stats.daily?.[hold]?.[era] ?? stats.daily?.[hold]?.all;
  const values = set?.[direction];
  if (!values || !Number.isFinite(values[key])) return null;
  return { pct: values[key], samples: values.n, basis: 'daily', holdDays: hold, era, percentile, instrument: stats.instrument };
}

/** How often the past windows reached `pct` — the honest reach rate of a level. */
export function reachRate({ stats, hhmm, holdDays = 0, side = 'CE', pct, era = 'recent' }) {
  if (!stats || !Number.isFinite(pct)) return null;
  // Percentiles are the stored summary; interpolate between the known points.
  const points = [30, 50, 70, 85, 95].map(p => ({ p, move: moveFor({ stats, hhmm, holdDays, side, percentile: p, era }) })).filter(item => item.move);
  if (!points.length) return null;
  const first = points[0];
  if (Math.abs(pct - first.move.pct) < 1e-9) return 1 - first.p / 100;
  if (pct < first.move.pct) {
    // Smaller than the smallest stored move: reach rises toward 1 as the ask shrinks.
    const share = pct / Math.max(1e-9, first.move.pct);
    return Math.min(1, (1 - first.p / 100) + (1 - share) * (first.p / 100));
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (pct <= b.move.pct) {
      const share = (pct - a.move.pct) / Math.max(1e-9, b.move.pct - a.move.pct);
      return (1 - a.p / 100) + share * ((1 - b.p / 100) - (1 - a.p / 100));
    }
  }
  return Math.max(0, 1 - points[points.length - 1].p / 100);
}