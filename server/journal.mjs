import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { isTradingDay, marketCloseMinuteFor, marketParts } from '../src/lib/marketSession.ts';

const require = createRequire(import.meta.url);
const journalRustDisabled = process.env.FAST_ANYTHING_DISABLE === '1';
let rustTrackCardFollowThrough = null;
let rustLoadError = null;
if (!journalRustDisabled) {
  try {
    ({ trackCardFollowThrough: rustTrackCardFollowThrough } = require('../.fast/lib/fa_server_journal_trackcardfollowthrough.node'));
  } catch (error) { rustLoadError = error; }
}
export const journalRustEnabled = !journalRustDisabled && Boolean(rustTrackCardFollowThrough);
const serializedJsonCache = new WeakMap();
let rustFallbackLogged = false;

const FIRST_MINUTE = 9 * 60 + 15;
const MINUTE_MS = 60_000;
const completedSessions = new Set();
const sentSummaries = new Set();

function validCard(card) {
  if (!card || typeof card.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(card.date) || typeof card.symbol !== 'string'
    || !Number.isFinite(card.at) || !Number.isFinite(card.entry) || card.entry <= 0
    || !Number.isFinite(card.sl) || !Number.isFinite(card.tgt1) || !Number.isFinite(card.tgt2)) return false;
  if (card.exchange === 'MCX') return card.side === 'FUT' && (card.strike == null);
  return Number.isFinite(card.strike) && (card.side === 'CE' || card.side === 'PE');
}

function belongsToDate(snapshot, date) {
  if (snapshot?.date !== date || !Number.isFinite(snapshot?.t)) return false;
  try { return marketParts(snapshot.t).dateKey === date; }
  catch { return false; }
}

function rowFor(card, snapshot) {
  const series = snapshot?.series?.find(item => item?.s === card.symbol);
  const side = card.side === 'CE' ? 0 : 1;
  // The card's own expiry selects the chain: near rows by default, December
  // rows when the card was built on the next-expiry block.
  const rows = typeof card.expiry === 'string' && series?.next?.e === card.expiry ? series.next.r : series?.r;
  return rows?.find(row => Array.isArray(row) && row[0] === card.strike && row[1] === side) ?? null;
}

function sessionCloseAt(date) {
  const probe = Date.parse(`${date}T12:00:00+05:30`);
  if (!Number.isFinite(probe)) return null;
  const close = marketCloseMinuteFor(probe);
  const hour = String(Math.floor(close / 60)).padStart(2, '0');
  const minute = String(close % 60).padStart(2, '0');
  return Date.parse(`${date}T${hour}:${minute}:00+05:30`);
}

function snapshotsForCard(card, minutes) {
  const closeAt = sessionCloseAt(card.date);
  return (Array.isArray(minutes) ? minutes : [])
    .filter(snapshot => belongsToDate(snapshot, card.date)
      && snapshot.t >= card.at && (closeAt == null || snapshot.t <= closeAt))
    .slice()
    .sort((a, b) => a.t - b.t);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function outcome(status, { r = null, mfe = 0, mae = 0, tgt2 = false, hitAt = null, minutes = 0, computedAt, day = null, closePremium = null, closeR = null }) {
  const base = { status, r, mfe: round2(mfe), mae: round2(mae), tgt2, hitAt, minutes, computedAt };
  // A swing card carries which session settled it, and its mark when still open.
  if (day) base.day = day;
  if (closePremium != null) base.closePremium = closePremium;
  if (closeR != null) base.closeR = closeR;
  return base;
}

/** Walk a card through its own date's ascending minute snapshots. */
export function resolveCard(card, minutes) {
  if (!validCard(card)) return null;
  const sessionClose = sessionCloseAt(card.date);
  const snapshots = snapshotsForCard(card, minutes);
  if (!snapshots.length) return null;

  let previousHigh = null;
  let previousLow = null;
  // Day high/low fields are cumulative; seed from the last pre-entry snapshot
  // so a move that happened before the card was created cannot settle it.
  const baseline = (Array.isArray(minutes) ? minutes : [])
    .filter(snapshot => belongsToDate(snapshot, card.date) && snapshot.t <= card.at
      && (sessionClose == null || snapshot.t <= sessionClose))
    .sort((a, b) => b.t - a.t)
    .find(snapshot => rowFor(card, snapshot));
  if (baseline) {
    const row = rowFor(card, baseline);
    const premium = row?.[2];
    if (Number.isFinite(premium)) {
      // Option row layout (marketFile.mjs, 18 fields): [strike, side, ltp,
      // prevClose, oi, prevOi, volume, prevVolume, avgPrice, iv, bid, ask,
      // bidQty, askQty, dayHigh(14), dayLow(15), lastTradeAt, delta].
      previousHigh = Math.max(premium, Number.isFinite(row[14]) ? row[14] : premium);
      previousLow = Math.min(premium, Number.isFinite(row[15]) ? row[15] : premium);
    }
  }

  let mfe = 0;
  let mae = 0;
  const denominator = card.entry - card.sl;
  const tgt1R = denominator > 0 ? round2((card.tgt1 - card.entry) / denominator) : null;
  const bearish = card.bias === 'bearish';

  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    const row = rowFor(card, snapshot);
    if (!row || !Number.isFinite(row[2]) || row[2] <= 0) continue;
    const premium = row[2];
    const favorable = bearish ? card.entry - premium : premium - card.entry;
    const adverse = bearish ? premium - card.entry : card.entry - premium;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);

    const high = Math.max(premium, Number.isFinite(row[14]) ? row[14] : premium);
    const low = Math.min(premium, Number.isFinite(row[15]) ? row[15] : premium);
    const stopRangeHit = previousLow != null && previousLow > card.sl && low <= card.sl;
    const targetRangeHit = previousHigh != null && previousHigh < card.tgt1 && high >= card.tgt1;
    const targetHit = premium >= card.tgt1 || targetRangeHit;
    const target2Hit = premium >= card.tgt2 || (previousHigh != null && previousHigh < card.tgt2 && high >= card.tgt2);

    // SL_EVAL=close5 (owner policy 2026-11-26): the stop fires only when a
    // 5-minute candle CLOSES beyond it — intrabar wicks no longer stop out.
    // The target stays touch-based ("target hit means hit"). The pending
    // bucket closes the moment the first snapshot of the NEXT bucket arrives.
    if (process.env.SL_EVAL === 'close5') {
      if (targetHit) {
        return outcome('tgt1', { r: tgt1R, mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });
      }
      const bucket = Math.floor(snapshot.t / (5 * 60_000));
      if (pendingBucket && pendingBucket.bucket !== bucket) {
        const breached = bearish ? pendingBucket.premium >= card.sl : pendingBucket.premium <= card.sl;
        if (breached) {
          return outcome('sl', { r: -1, mfe, mae, hitAt: pendingBucket.t, minutes: index + 1, computedAt: snapshot.t, slBasis: '5min-close' });
        }
      }
      pendingBucket = { bucket, premium, t: snapshot.t };
      previousHigh = high;
      previousLow = low;
      continue;
    }

    const stopHit = premium <= card.sl || stopRangeHit;

    if (stopHit && targetHit) {
      return outcome('ambiguous', { r: -1, mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });
    }
    if (stopHit) return outcome('sl', { r: -1, mfe, mae, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });
    if (targetHit) return outcome('tgt1', { r: tgt1R, mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });

    previousHigh = high;
    previousLow = low;
  }

  // A pending unclosed bucket at the session's end still counts: its last
  // print IS that bucket's close.
  if (process.env.SL_EVAL === 'close5' && pendingBucket) {
    const breached = bearish ? pendingBucket.premium >= card.sl : pendingBucket.premium <= card.sl;
    if (breached) return outcome('sl', { r: -1, mfe, mae, hitAt: pendingBucket.t, minutes: snapshots.length, computedAt: pendingBucket.t, slBasis: '5min-close' });
  }

  return outcome('open', { mfe, mae, minutes: snapshots.length, computedAt: snapshots.at(-1).t });
}

/**
 * MCX futures-direct cards (MCX_FULL_SPEC C4): entry/SL/TGT are ABSOLUTE
 * futures prices, so the walk runs over the symbol's own futures candles
 * (t ≥ card.at) instead of option rows. Same first-touch semantics as
 * resolveCard; a candle that touches both = ambiguous (counts as SL).
 * Returns null when the day has no candles — never a guess.
 */
export function resolveMcxCard(card, candles) {
  if (!validCard(card) || card.exchange !== 'MCX' || !Array.isArray(candles) || !candles.length) return null;
  const bearish = card.bias === 'bearish';
  const denominator = bearish ? card.sl - card.entry : card.entry - card.sl;
  const tgt1R = denominator > 0 ? round2(Math.abs(card.tgt1 - card.entry) / denominator) : null;
  let mfe = 0;
  let mae = 0;
  const path = candles.filter(candle => Number.isSafeInteger(candle?.at) && candle.at >= card.at
    && Number.isFinite(candle?.high) && Number.isFinite(candle?.low)).sort((a, b) => a.at - b.at);
  if (!path.length) return null;
  for (let index = 0; index < path.length; index++) {
    const candle = path[index];
    const favorable = bearish ? card.entry - candle.low : candle.high - card.entry;
    const adverse = bearish ? candle.high - card.entry : card.entry - candle.low;
    mfe = Math.max(mfe, favorable);
    mae = Math.max(mae, adverse);
    const stopHit = bearish ? candle.high >= card.sl : candle.low <= card.sl;
    const targetHit = bearish ? candle.low <= card.tgt1 : candle.high >= card.tgt1;
    if (stopHit && targetHit) return outcome('ambiguous', { r: -1, mfe, mae, hitAt: candle.at, minutes: index + 1, computedAt: candle.at });
    if (stopHit) return outcome('sl', { r: -1, mfe, mae, hitAt: candle.at, minutes: index + 1, computedAt: candle.at });
    if (targetHit) return outcome('tgt1', { r: tgt1R, mfe, mae, tgt2: bearish ? candle.low <= card.tgt2 : candle.high >= card.tgt2, hitAt: candle.at, minutes: index + 1, computedAt: candle.at });
  }
  const lastClose = Number(path.at(-1).close);
  const closeR = denominator !== 0 && Number.isFinite(lastClose) ? round2((bearish ? card.entry - lastClose : lastClose - card.entry) / denominator) : null;
  return outcome('open', { mfe, mae, minutes: path.length, computedAt: path.at(-1).at, closePremium: Number.isFinite(lastClose) ? lastClose : null, closeR });
}

/**
 * A swing card on a LATER session: the entry, stop and targets stay the ones
 * the card was issued with, but the path walked is this day's. Without this a
 * multi-day card is graded only on its first day and then sits "open" forever.
 *
 * Returns the same outcome shape plus `day`, or null when the contract did not
 * print that day (never a guess).
 */
export function resolveSwingDay(card, minutes, date) {
  if (!validCard(card) || !date || date <= card.date) return null;
  const snapshots = (Array.isArray(minutes) ? minutes : [])
    .filter(snapshot => belongsToDate(snapshot, date) && rowFor(card, snapshot))
    .sort((a, b) => a.t - b.t);
  if (!snapshots.length) return null;
  const bearish = card.bias === 'bearish';
  const denominator = card.entry - card.sl;
  const tgt1R = denominator > 0 ? round2((card.tgt1 - card.entry) / denominator) : null;
  let mfe = 0;
  let mae = 0;
  let previousHigh = null;
  let previousLow = null;
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    const row = rowFor(card, snapshot);
    const premium = row?.[2];
    if (!Number.isFinite(premium) || premium <= 0) continue;
    mfe = Math.max(mfe, bearish ? card.entry - premium : premium - card.entry);
    mae = Math.max(mae, bearish ? premium - card.entry : card.entry - premium);
    const high = Math.max(premium, Number.isFinite(row[14]) ? row[14] : premium);
    const low = Math.min(premium, Number.isFinite(row[15]) ? row[15] : premium);
    const stopHit = premium <= card.sl || (previousLow != null && previousLow > card.sl && low <= card.sl);
    const targetHit = premium >= card.tgt1 || (previousHigh != null && previousHigh < card.tgt1 && high >= card.tgt1);
    const target2Hit = premium >= card.tgt2 || (previousHigh != null && previousHigh < card.tgt2 && high >= card.tgt2);
    const base = { mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t, day: date };
    if (stopHit && targetHit) return outcome('ambiguous', { ...base, r: -1 });
    if (stopHit) return outcome('sl', { ...base, r: -1 });
    if (targetHit) return outcome('tgt1', { ...base, r: tgt1R });
    previousHigh = high;
    previousLow = low;
  }
  const last = snapshots[snapshots.length - 1];
  const mark = rowFor(card, last)?.[2];
  const closeR = Number.isFinite(mark) && denominator > 0
    ? round2(((bearish ? card.entry - mark : mark - card.entry)) / denominator)
    : null;
  return outcome('open', { mfe, mae, minutes: snapshots.length, computedAt: last.t, day: date, closePremium: Number.isFinite(mark) ? mark : null, closeR });
}

/** Evidence through close, separate from the journal's first-exit result/R. */
export function trackCardFollowThroughJs(card, minutes, { source = 'raw', futuresCandles = [] } = {}) {
  if (!validCard(card) || !(card.sl > 0 && card.sl < card.entry && card.tgt1 > card.entry && card.tgt2 >= card.tgt1)) return null;
  const closeAt = sessionCloseAt(card.date);
  const openAt = Date.parse(`${card.date}T09:15:00+05:30`);
  if (closeAt == null || card.at < openAt || card.at >= closeAt + MINUTE_MS
    || !belongsToDate({ date: card.date, t: card.at }, card.date)) return null;

  const firstMinute = Math.floor(card.at / MINUTE_MS);
  const expectedMinutes = Math.floor(closeAt / MINUTE_MS) - firstMinute + 1;
  const records = [];
  for (const snapshot of Array.isArray(minutes) ? minutes : []) {
    // The session gate includes its closing minute (e.g. the 15:40:03 capture).
    if (!belongsToDate(snapshot, card.date) || snapshot.t < openAt || snapshot.t >= closeAt + MINUTE_MS) continue;
    const series = (Array.isArray(snapshot.series) ? snapshot.series : []).find(item => item?.s === card.symbol);
    const onNear = typeof card.expiry === 'string' && series?.e === card.expiry;
    const onNext = typeof card.expiry === 'string' && series?.next?.e === card.expiry;
    if (!onNear && !onNext) continue;
    const rows = onNext ? series.next.r : series.r;
    const row = (Array.isArray(rows) ? rows : []).find(item => Array.isArray(item) && item[0] === card.strike && item[1] === (card.side === 'CE' ? 0 : 1));
    if (!row || !Number.isFinite(row[2]) || row[2] <= 0) continue;
    const at = Number.isFinite(series.t) ? series.t : snapshot.t;
    if (at < openAt || at > snapshot.t || at >= closeAt + MINUTE_MS) continue;
    records.push({ at, row });
  }
  records.sort((a, b) => a.at - b.at);

  let previousHigh = null, previousLow = null;
  let firstAt = null, lastAt = null;
  const range = { open: null, high: null, low: null, close: null };
  const touches = { sl: null, tgt1: null, tgt2: null };
  const observedMinutes = new Set();
  for (const { at, row } of records) {
    const premium = row[2];
    const high = Number.isFinite(row[14]) && row[14] >= premium ? row[14] : null;
    const low = Number.isFinite(row[15]) && row[15] > 0 && row[15] <= premium ? row[15] : null;
    if (at >= card.at) {
      observedMinutes.add(Math.floor(at / MINUTE_MS));
      if (firstAt == null) { firstAt = at; range.open = premium; }
      lastAt = at;
      range.close = premium;
      range.high = Math.max(range.high ?? premium, premium);
      range.low = Math.min(range.low ?? premium, premium);

      // A cumulative extreme proves a post-call move only when it increases
      // beyond an extreme actually observed at/after the call, not before it.
      const newHigh = high != null && previousHigh != null && previousHigh.at >= card.at && previousHigh.at < at && high > previousHigh.value;
      const newLow = low != null && previousLow != null && previousLow.at >= card.at && previousLow.at < at && low < previousLow.value;
      if (newHigh) range.high = Math.max(range.high, high);
      if (newLow) range.low = Math.min(range.low, low);
      for (const [key, level] of [['sl', card.sl], ['tgt1', card.tgt1], ['tgt2', card.tgt2]]) {
        if (touches[key]) continue;
        const quoteHit = key === 'sl' ? premium <= level : premium >= level;
        const rangeHit = key === 'sl' ? newLow && low <= level : newHigh && high >= level;
        if (quoteHit || rangeHit) {
          touches[key] = {
            at,
            after: quoteHit ? at : (key === 'sl' ? previousLow.at : previousHigh.at),
            source: quoteHit ? 'ltp' : 'day-range',
          };
        }
      }
    }
    if (high != null) previousHigh = { value: high, at };
    if (low != null) previousLow = { value: low, at };
  }

  const target = touches.tgt1 ?? touches.tgt2;
  const stop = touches.sl;
  let sequence = 'none-observed';
  if (stop && target) {
    const before = (first, next) => next.source === 'day-range' ? first.at <= next.after : first.at < next.after;
    sequence = before(stop, target) ? 'sl-first' : before(target, stop) ? 'target-first' : 'ambiguous';
  } else if (stop) sequence = 'sl-first';
  else if (target) sequence = 'target-first';
  const sampleCount = observedMinutes.size;
  const missingMinutes = Math.max(0, expectedMinutes - sampleCount);
  const firstFullMinute = Math.ceil(card.at / MINUTE_MS) * MINUTE_MS;
  const futureMinutes = (Array.isArray(futuresCandles) ? futuresCandles : []).filter(candle =>
    Number.isSafeInteger(candle?.at) && candle.at % MINUTE_MS === 0
      && candle.at >= firstFullMinute && candle.at + MINUTE_MS <= closeAt
      && Number.isFinite(candle.high) && Number.isFinite(candle.low)
      && candle.low > 0 && candle.high >= candle.low);
  const futures = futureMinutes.length ? {
    high: Math.max(...futureMinutes.map(candle => candle.high)),
    low: Math.min(...futureMinutes.map(candle => candle.low)),
    from: Math.min(...futureMinutes.map(candle => candle.at)),
    to: Math.max(...futureMinutes.map(candle => candle.at)) + MINUTE_MS,
  } : null;
  return {
    version: 1,
    source,
    from: card.at,
    sessionCloseAt: closeAt,
    firstAt,
    lastAt,
    sampleCount,
    expectedMinutes,
    missingMinutes,
    coverage: sampleCount === 0 ? 'missing' : missingMinutes ? 'partial' : 'complete',
    range: Object.fromEntries(Object.entries(range).map(([key, value]) => [key, value == null ? null : round2(value)])),
    touches,
    sequence,
    futures,
  };
}

function stringifyOnce(value) {
  const cached = serializedJsonCache.get(value);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(value);
  serializedJsonCache.set(value, serialized);
  return serialized;
}

function logRustFallback(error) {
  if (rustFallbackLogged) return;
  console.warn(`journal Rust wrapper fallback: ${error?.message || error || 'native addon unavailable'}`);
  rustFallbackLogged = true;
}

export function trackCardFollowThrough(card, minutes, options = {}) {
  if (journalRustDisabled || !Array.isArray(minutes) || minutes.length === 0) {
    return trackCardFollowThroughJs(card, minutes, options);
  }
  if (!rustTrackCardFollowThrough) {
    logRustFallback(rustLoadError);
    return trackCardFollowThroughJs(card, minutes, options);
  }
  try {
    const minutesJson = stringifyOnce(minutes);
    const futuresJson = Array.isArray(options.futuresCandles) ? stringifyOnce(options.futuresCandles) : null;
    return rustTrackCardFollowThrough(card, minutesJson, options.source ?? 'raw', futuresJson);
  } catch (error) {
    logRustFallback(error);
    return trackCardFollowThroughJs(card, minutes, options);
  }
}

function journalCardKey(card) {
  return JSON.stringify([card.symbol, card.date, card.at, card.expiry, card.strike, card.side, card.entry, card.sl, card.tgt1, card.tgt2]);
}

/** Both EOD and offline writers use the same exclusive lock; never wait/retry. */
export function withJournalStoreLock(path, update) {
  const lockPath = `${path}.journal.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const lock = openSync(lockPath, 'wx');
  try { return update(); }
  finally { closeSync(lock); unlinkSync(lockPath); }
}

function readCards(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.cards)) throw new Error('observations store has no cards array');
    return parsed.cards;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function writeCards(path, cards, store = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ...store, cards }, null, 2));
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing was staged */ }
    throw error;
  }
}

function formatR(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function summaryFor(date, cards) {
  const targets = cards.filter(card => card.outcome.status === 'tgt1');
  const stops = cards.filter(card => card.outcome.status === 'sl');
  const ambiguous = cards.filter(card => card.outcome.status === 'ambiguous');
  const averageR = targets.length ? targets.reduce((sum, card) => sum + (card.outcome.r ?? 0), 0) / targets.length : null;
  const header = `📓 JOURNAL ${date}: ${cards.length} resolved — ${targets.length} TGT1 (R ${averageR == null ? '—' : `${formatR(averageR)} avg`}), ${stops.length} SL, ${ambiguous.length} ambiguous`;
  const lines = cards.slice(0, 5).map(card => {
    const suffix = card.outcome.status === 'ambiguous' ? ' AMB' : '';
    return `${card.symbol} ${card.strike}${card.side} ${suffix} R${formatR(card.outcome.r)}`;
  });
  if (cards.length > lines.length && lines.length) lines[lines.length - 1] += ` · +${cards.length - lines.length} more`;
  return [header, ...lines].join('\n');
}

function emptyOpen(card, snapshots, now) {
  const later = snapshotsForCard(card, snapshots);
  return outcome('open', {
    minutes: later.length,
    computedAt: later.at(-1)?.t ?? sessionCloseAt(card.date) ?? now,
  });
}

/** Resolve persisted observations once after close, grouped by each card's own session date. */
export async function runJournal({ obsPath, readMinute, readFuturesSnapshot = () => null, now = Date.now(), log = () => {}, send } = {}) {
  if (!obsPath || typeof readMinute !== 'function') return { skipped: 'not configured' };
  let day;
  try { day = marketParts(now); }
  catch (error) { return { skipped: 'invalid time', error: String(error?.message || error) }; }
  const sessionDate = day.dateKey;
  const closeMinute = marketCloseMinuteFor(now);
  if (!isTradingDay(new Date(now))) return { skipped: 'not a session day', date: sessionDate };
  if (day.minuteOfDay < closeMinute) return { skipped: 'before close', date: sessionDate };
  if (completedSessions.has(sessionDate)) return { skipped: 'already ran', date: sessionDate };

  let cards;
  try { cards = readCards(obsPath); }
  catch (error) {
    log(`journal observations read failed: ${String(error?.message || error)}`);
    return { skipped: 'read failed', date: sessionDate };
  }

  const pendingCards = cards.filter(card => validCard(card)
    && (card.outcome?.followThrough?.version !== 1 || card.outcome.followThrough.coverage === 'missing') && card.date <= sessionDate);
  const pendingDates = [...new Set(pendingCards.map(card => card.date))].sort();
  const snapshotsByDate = new Map();
  const mismatchedSnapshotDates = new Set();
  for (const date of pendingDates) {
    const closeAt = sessionCloseAt(date);
    if (closeAt == null) continue;
    const close = marketCloseMinuteFor(closeAt);
    const snapshots = [];
    try {
      for (let minute = FIRST_MINUTE; minute <= close; minute++) {
        const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`;
        const snapshot = await readMinute(date, hhmm);
        if (!snapshot) continue;
        if (belongsToDate(snapshot, date)) snapshots.push(snapshot);
        else mismatchedSnapshotDates.add(date);
      }
    } catch (error) {
      log(`journal minute read failed for ${date}: ${String(error?.message || error)}`);
      return { skipped: 'minute read failed', date: sessionDate };
    }
    snapshotsByDate.set(date, snapshots);
  }

  const futuresByCard = new Map();
  for (const card of pendingCards) {
    const key = `${card.symbol}|${card.date}`;
    if (futuresByCard.has(key)) continue;
    futuresByCard.set(key, []);
    try {
      const snapshot = await readFuturesSnapshot(card.symbol, card.date);
      if (snapshot?.symbol === card.symbol && snapshot?.session === card.date && Array.isArray(snapshot.months)) {
        const candles = snapshot.months[0]?.candles;
        if (Array.isArray(candles)) futuresByCard.set(key, candles);
      }
    } catch (error) {
      log(`journal futures unavailable for ${card.symbol} ${card.date}: ${String(error?.message || error)}`);
    }
  }

  // Swing carry-over: a card issued earlier whose hold is still running gets
  // graded on TODAY's path too, with its original entry/stop/targets.
  const swingCards = cards.filter(card => validCard(card)
    && card.horizon === 'swing' && card.date < sessionDate
    && (!card.holdTill || sessionDate <= card.holdTill)
    && (!card.outcome || card.outcome.status === 'open'));
  if (swingCards.length && !snapshotsByDate.has(sessionDate)) {
    const closeAt = sessionCloseAt(sessionDate);
    const close = closeAt == null ? marketCloseMinuteFor(now) : marketCloseMinuteFor(closeAt);
    const snapshots = [];
    try {
      for (let minute = FIRST_MINUTE; minute <= close; minute++) {
        const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`;
        const snapshot = await readMinute(sessionDate, hhmm);
        if (snapshot && belongsToDate(snapshot, sessionDate)) snapshots.push(snapshot);
      }
    } catch (error) {
      log(`journal swing minute read failed for ${sessionDate}: ${String(error?.message || error)}`);
    }
    snapshotsByDate.set(sessionDate, snapshots);
  }
  const swingResults = new Map();
  for (const card of swingCards) {
    const result = resolveSwingDay(card, snapshotsByDate.get(sessionDate) ?? [], sessionDate);
    if (result) swingResults.set(journalCardKey(card), result);
  }

  const resolvedByDate = new Map();
  let written = 0;
  const updates = new Map();
  const updated = cards.map(card => {
    const swing = swingResults.get(journalCardKey(card));
    if (swing) {
      written++;
      if (swing.status !== 'open') {
        const dateCards = resolvedByDate.get(sessionDate) ?? [];
        dateCards.push({ ...card, outcome: swing });
        resolvedByDate.set(sessionDate, dateCards);
      }
      const marks = [...(card.marks ?? []), { date: sessionDate, status: swing.status, closePremium: swing.closePremium ?? null, closeR: swing.closeR ?? null }].slice(-20);
      updates.set(journalCardKey(card), swing);
      return { ...card, outcome: swing, marks };
    }
    if (card.exchange === 'MCX') {
      // MCX cards resolve against their own futures candles — market-file
      // minute snapshots are irrelevant to them (no option rows exist).
      if (card.outcome?.status && card.outcome.status !== 'open') return card;
      const candles = futuresByCard.get(`${card.symbol}|${card.date}`);
      if (!candles?.length) return card;
      const mcxResult = card.outcome ?? resolveMcxCard(card, candles) ?? null;
      if (!mcxResult) return card;
      written++;
      if (!card.outcome && mcxResult.status !== 'open') {
        const dateCards = resolvedByDate.get(card.date) ?? [];
        dateCards.push({ ...card, outcome: mcxResult });
        resolvedByDate.set(card.date, dateCards);
      }
      updates.set(journalCardKey(card), mcxResult);
      return { ...card, outcome: mcxResult };
    }
    if (!validCard(card) || (card.outcome?.followThrough?.version === 1 && card.outcome.followThrough.coverage !== 'missing') || card.date > sessionDate) return card;
    const snapshots = snapshotsByDate.get(card.date);
    if (!snapshots) return card;
    // Enrich archived history offline, never replace a saved result using an
    // empty raw reader or load a whole archive in the API process.
    if (card.outcome && !snapshots.length) return card;
    if (!snapshots.length && mismatchedSnapshotDates.has(card.date)) return card;
    const result = card.outcome ?? resolveCard(card, snapshots) ?? emptyOpen(card, snapshots, now);
    const followThrough = trackCardFollowThrough(card, snapshots, { futuresCandles: futuresByCard.get(`${card.symbol}|${card.date}`) });
    const enriched = followThrough ? { ...result, followThrough } : result;
    written++;
    if (!card.outcome && result.status !== 'open') {
      const dateCards = resolvedByDate.get(card.date) ?? [];
      dateCards.push({ ...card, outcome: result });
      resolvedByDate.set(card.date, dateCards);
    }
    updates.set(journalCardKey(card), enriched);
    return { ...card, outcome: enriched };
  });

  if (written) {
    try {
      // The minute reads yield; retain cards/outcomes written by another pass
      // during that work rather than replacing the observations store wholesale.
      withJournalStoreLock(obsPath, () => {
        const store = JSON.parse(readFileSync(obsPath, 'utf8'));
        if (!Array.isArray(store?.cards)) throw new Error('Observations store has no cards array.');
        const latest = store.cards.map(card => {
          const enriched = updates.get(journalCardKey(card));
          if (!enriched || (card.outcome?.followThrough?.version === 1 && card.outcome.followThrough.coverage !== 'missing')) return card;
          return { ...card, outcome: card.outcome ? { ...card.outcome, followThrough: enriched.followThrough } : enriched };
        });
        writeCards(obsPath, latest, store);
      });
    }
    catch (error) {
      log(`journal observations save failed: ${String(error?.message || error)}`);
      return { skipped: 'save failed', date: sessionDate };
    }
  }
  completedSessions.add(sessionDate);

  const summaryCards = new Map();
  for (const card of updated) {
    if (!card?.outcome || card.outcome.status === 'open' || !Number.isFinite(card.outcome.computedAt)) continue;
    let outcomeDate;
    try { outcomeDate = marketParts(card.outcome.computedAt).dateKey; }
    catch { continue; }
    if (outcomeDate !== card.date || (outcomeDate !== sessionDate && !resolvedByDate.has(card.date))) continue;
    const dateCards = summaryCards.get(card.date) ?? [];
    dateCards.push(card);
    summaryCards.set(card.date, dateCards);
  }

  for (const [date, resolved] of summaryCards) {
    if (!send || sentSummaries.has(date)) continue;
    sentSummaries.add(date);
    try {
      const result = await send(summaryFor(date, resolved));
      if (result?.sent === false) log(`journal summary not sent for ${date} (${result.reason ?? result.status ?? 'unknown'})`);
    } catch (error) {
      log(`journal summary failed for ${date}: ${String(error?.message || error)}`);
    }
  }
  return { date: sessionDate, written, resolved: [...resolvedByDate.values()].reduce((sum, list) => sum + list.length, 0) };
}
