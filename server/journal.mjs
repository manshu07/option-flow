import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTradingDay, marketCloseMinuteFor, marketParts } from '../src/lib/marketSession.ts';

const FIRST_MINUTE = 9 * 60 + 15;
const MINUTE_MS = 60_000;
const completedSessions = new Set();
const sentSummaries = new Set();

function validCard(card) {
  return card && typeof card.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.date) && typeof card.symbol === 'string'
    && Number.isFinite(card.at) && Number.isFinite(card.strike)
    && (card.side === 'CE' || card.side === 'PE')
    && Number.isFinite(card.entry) && card.entry > 0
    && Number.isFinite(card.sl) && Number.isFinite(card.tgt1) && Number.isFinite(card.tgt2);
}

function belongsToDate(snapshot, date) {
  if (snapshot?.date !== date || !Number.isFinite(snapshot?.t)) return false;
  try { return marketParts(snapshot.t).dateKey === date; }
  catch { return false; }
}

function rowFor(card, snapshot) {
  const series = snapshot?.series?.find(item => item?.s === card.symbol);
  const side = card.side === 'CE' ? 0 : 1;
  return series?.r?.find(row => Array.isArray(row) && row[0] === card.strike && row[1] === side) ?? null;
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

function outcome(status, { r = null, mfe = 0, mae = 0, tgt2 = false, hitAt = null, minutes = 0, computedAt }) {
  return { status, r, mfe: round2(mfe), mae: round2(mae), tgt2, hitAt, minutes, computedAt };
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
    const stopHit = premium <= card.sl || stopRangeHit;
    const targetHit = premium >= card.tgt1 || targetRangeHit;
    const target2Hit = premium >= card.tgt2 || (previousHigh != null && previousHigh < card.tgt2 && high >= card.tgt2);

    if (stopHit && targetHit) {
      return outcome('ambiguous', { r: -1, mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });
    }
    if (stopHit) return outcome('sl', { r: -1, mfe, mae, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });
    if (targetHit) return outcome('tgt1', { r: tgt1R, mfe, mae, tgt2: target2Hit, hitAt: snapshot.t, minutes: index + 1, computedAt: snapshot.t });

    previousHigh = high;
    previousLow = low;
  }

  return outcome('open', { mfe, mae, minutes: snapshots.length, computedAt: snapshots.at(-1).t });
}

/** Evidence through close, separate from the journal's first-exit result/R. */
export function trackCardFollowThrough(card, minutes, { source = 'raw' } = {}) {
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
    const series = (Array.isArray(snapshot.series) ? snapshot.series : []).find(item => item?.s === card.symbol && typeof card.expiry === 'string' && item?.e === card.expiry);
    const row = (Array.isArray(series?.r) ? series.r : []).find(item => Array.isArray(item) && item[0] === card.strike && item[1] === (card.side === 'CE' ? 0 : 1));
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
  };
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
export async function runJournal({ obsPath, readMinute, now = Date.now(), log = () => {}, send } = {}) {
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

  const pendingDates = [...new Set(cards
    .filter(card => validCard(card) && (card.outcome?.followThrough?.version !== 1 || card.outcome.followThrough.coverage === 'missing') && card.date <= sessionDate)
    .map(card => card.date))].sort();
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

  const resolvedByDate = new Map();
  let written = 0;
  const updates = new Map();
  const updated = cards.map(card => {
    if (!validCard(card) || (card.outcome?.followThrough?.version === 1 && card.outcome.followThrough.coverage !== 'missing') || card.date > sessionDate) return card;
    const snapshots = snapshotsByDate.get(card.date);
    if (!snapshots) return card;
    // Enrich archived history offline, never replace a saved result using an
    // empty raw reader or load a whole archive in the API process.
    if (card.outcome && !snapshots.length) return card;
    if (!snapshots.length && mismatchedSnapshotDates.has(card.date)) return card;
    const result = card.outcome ?? resolveCard(card, snapshots) ?? emptyOpen(card, snapshots, now);
    const followThrough = trackCardFollowThrough(card, snapshots);
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
