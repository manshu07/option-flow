/**
 * Order Flow's server: the page's only data source, and its host.
 *
 *   GET /api/status                  which provider, its clock, what the last build did
 *   GET /api/market                  the market file: every underlying's nearest-expiry chain
 *   GET /api/market/<date>/<HHMM>    an earlier minute of today (the 15m / 1h windows)
 *   GET /api/futures/<SYMBOL>?session=YYYY-MM-DD   its futures months and 1-minute candles
 *   GET /api/orb                     the ORB scanner list for the current session
 *   GET /api/participation           near vs next expiry OI shifts (rollover view)
 *   GET /api/pcr                     current near-chain PCR and trailing 15m shift
 *   GET /api/replay/<date>/manifest  captured market minutes and futures coverage
 *   GET /api/replay/<date>/futures/<SYMBOL>?asOf=HHMM  persisted futures at a cursor
 *   GET /api/strikes/<SYMBOL>?date=&asOf=HHMM      one underlying's per-strike premium
 *                                      series, read off stored minute snapshots
 *   POST /api/capture/now            request a non-blocking futures capture pass
 *   GET /api/archive                 verified EOD archive metadata
 *   POST /api/archive/<date>         request a non-blocking EOD archive
 *   GET /*                           the built page from dist/ (npm run build)
 *
 * Where the numbers come from is a provider (server/providers): the built-in
 * demo market by default, or a broker adapter chosen with MF_PROVIDER. The
 * collector asks the provider for each underlying's expiries once a session
 * and its nearest live chain each minute, eight at a time, and writes the
 * market file. Futures are read on demand and kept briefly. Session rules
 * (holidays, the close, settled expiries) come from the page's own
 * src/lib/marketSession.ts, so the server and the page never disagree.
 *
 *   PORT=8787  HOST=127.0.0.1  MF_PROVIDER=demo  MF_DATA_DIR=server/data
 *
 * Security. It listens on this machine only (HOST=127.0.0.1) unless told
 * otherwise. MF_BASIC_AUTH=user:password puts every route behind a password.
 * Only GET and HEAD; only the routes below; the futures route reads only the
 * current session; no cross-origin reads unless MF_CORS_ORIGIN names one;
 * strict security headers on every answer; provider errors are logged here,
 * never sent to the browser.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeSeries, marketFile } from './marketFile.mjs';
import { createProvider } from './providers/index.mjs';
import { futuresCoverage, persistFutures, readFutures, readReplayMinutes, ReplayDataError, REPLAY_DATE, REPLAY_SYMBOL, truncateFutures } from './replayStorage.mjs';
import { captureRequest, createCapture, withCaptureStatus } from './capture.mjs';
import { BROADCAST_FOOTER, createAlertDigestState, flushScheduledDigests, runAlerts } from './alerts.mjs';
import { orbScan, orbSlotDue, orbMessage } from './orb.mjs';
import { participation } from './participation.mjs';
import { hoursLeft, tokenReminder } from './tokenWatch.mjs';
import { formatHistoryRefreshSummary, futureCaptureBelowCoverage, historyRefreshDue, runHistoryRefresh, istParts } from './historyRefresh.mjs';
import { mcxEveningBrief, mcxWatchPoll } from './mcx.mjs';
import { sendTelegram } from './telegram.mjs';
import { activeChatIds, loadSubscribers, pollCommands } from './subscribers.mjs';
import { sectorMapFromUnderlyings } from './orbModel.mjs';
import { liveErrorMessage, liveSnapshotMessage, obsSnapshotMessage, oiSnapshotMessage } from './liveCommand.mjs';
import { formatJournalMessage } from './journalCommand.mjs';
import { gapOpenDue, gapOpenMessage } from './gapOpen.mjs';
import { weeklyReviewDue, weeklyReviewMessage } from './weeklyReview.mjs';
import { capturePreviousOiBaseline, fillMissingPrevOi } from './oiBaseline.mjs';
import { isFullOptionChainSnapshot, persistFullOptionChainSnapshots } from './optionChainSnapshots.mjs';
import { createPcrHistory, pcrSnapshot } from './pcrHistory.mjs';
import { runTriage } from './typesafe.mjs';
import { loadObservations, runAdvisor, runMcxCards } from './strikeAdvisor.mjs';
import { runJournal } from './journal.mjs';
import { archiveRequestAsync, createArchiveService, listReplayDays, readArchiveFuturesFallback, readArchiveMinuteFallback } from './archive.mjs';
import { perfMark, startPerfProbe } from './perfProbe.mjs';
import { filterLiveExpiries, getLatestTradingSessionDate, getPreviousTradingDay, isMarketSessionTime, isTradingDay, marketCloseMinuteFor, marketParts, marketSessionBounds, sessionFor } from '../src/lib/marketSession.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const AUTH = process.env.MF_BASIC_AUTH || '';
const CORS_ORIGIN = process.env.MF_CORS_ORIGIN || '';
if (AUTH && !/^[^:]+:.{8,}$/.test(AUTH)) throw new Error('MF_BASIC_AUTH must be user:password, with a password of at least 8 characters.');
const DATA_DIR = path.resolve(ROOT, process.env.MF_DATA_DIR || 'server/data');
const SUBSCRIBERS_PATH = path.join(DATA_DIR, 'subscribers.json');
const DIST = path.join(ROOT, 'dist');
const OWNER_DISCLAIMER = '🎓 educational captured market data only · not investment advice';
const WORKERS = 8;
/** A futures read is kept this long: the page asks again every two minutes. */
const FUTURES_KEEP_MS = 60_000;
const DEFAULT_MCX_SYMBOLS = ['GOLD', 'SILVER', 'NATURALGAS', 'GOLDM', 'SILVERM', 'NATURALGASM'];

const log = (...args) => console.log(new Date().toISOString(), ...args);

const requestedMcx = process.env.MCX_SYMBOLS == null
  ? new Set(DEFAULT_MCX_SYMBOLS)
  : new Set(process.env.MCX_SYMBOLS.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean));
const unknownMcx = [...requestedMcx].filter(symbol => !DEFAULT_MCX_SYMBOLS.includes(symbol));
if (unknownMcx.length) log(`mcx: ignoring unknown MCX_SYMBOLS: ${unknownMcx.join(',')}`);
for (const symbol of unknownMcx) requestedMcx.delete(symbol);
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/underlyings.json'), 'utf8')).underlyings
  .filter(u => u && typeof u.symbol === 'string' && u.lot > 0)
  .filter(u => (u.exchange ?? u.exch) !== 'MCX' || requestedMcx.has(u.symbol.toUpperCase()));
const bySymbol = new Map(universe.map(u => [u.symbol, u]));
const isMcxUnderlying = underlying => (underlying?.exchange ?? underlying?.exch) === 'MCX';
// `--recorded` (npm run dev:recorded / start:recorded) and `--archive` (npm run dev:archive) are shortcuts for MF_PROVIDER.
const flagged = ['recorded', 'archive'].find(id => process.argv.includes(`--${id}`));
const provider = createProvider(universe, flagged);
{
  const expiresAt = provider.health?.()?.tokenExpiresAt ?? null;
  const left = hoursLeft(expiresAt);
  if (left != null) log(`dhan: access token valid for ${left}h${left <= 6 ? ' — regenerate before the next market open' : ''}`);
}
const now = () => (provider.now ? provider.now() : Date.now());
const SCAN_DIR = path.join(DATA_DIR, provider.id);
const ARCHIVE_ROOT = path.join(DATA_DIR, 'archives');
const BOOTED_AT = Date.now();

// ── Collector ─────────────────────────────────────────────────────────────

/** Expiries are read once a session: they change only when a contract lists or expires. */
const ladderCache = { session: '', bySymbol: new Map() };
const state = { ready: false, building: false, latestJson: null, latest: null, lastBuild: null, lastError: null };
// Near-chain PCR deltas for momentum early-card filtering, isolated to each session.
const pcrHistory = createPcrHistory(100);
const alertState = new Map();
const alertDigestState = createAlertDigestState();
// ORB scanner (P1): one scan per day slot, cached for /api/orb between builds.
const orbState = { session: null, sent: new Set(), last: null };
// Dhan's token dies 24h after issue; one reminder per level per session.
const tokenWatch = { sentFor: null };
// Daily futures-history refresh (bhavcopy → capture fold → stats), after 19:30 IST.
const historyState = { lastRun: null, running: false };
const ORB_SECTORS = sectorMapFromUnderlyings(universe);
const journalMinuteIndexes = new Map();
let previousOiSessionDate = null;
let previousOiBaseline = new Map();
const persistedFullChainCaptures = new Set();

const hhmmOf = at => { const p = marketParts(at); return `${String(Math.floor(p.minuteOfDay / 60)).padStart(2, '0')}${String(p.minuteOfDay % 60).padStart(2, '0')}`; };

/** Today's stored minutes, ascending, as [HHMM, epoch ms]: an index beside them, not a read of every file. */
function readMinutes(date) {
  try { return JSON.parse(fs.readFileSync(path.join(SCAN_DIR, date, 'index.json'), 'utf8')); } catch { return []; }
}
function storeMinute(date, at, json) {
  const dir = path.join(SCAN_DIR, date);
  fs.mkdirSync(dir, { recursive: true });
  const hhmm = hhmmOf(at);
  fs.writeFileSync(path.join(dir, `${hhmm}.json`), json);
  const minutes = readMinutes(date).filter(entry => entry[0] !== hhmm);
  minutes.push([hhmm, at]);
  minutes.sort((a, b) => a[1] - b[1]);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(minutes));
  return minutes;
}

function persistProviderFullChains() {
  if (typeof provider.fullChainSnapshots !== 'function') return 0;
  const pending = provider.fullChainSnapshots().filter(snapshot =>
    isFullOptionChainSnapshot(snapshot, snapshot?.symbol, snapshot?.session)
      && !persistedFullChainCaptures.has(`${snapshot.session}:${snapshot.symbol}:${snapshot.capturedAt}`));
  if (!pending.length) return 0;
  try {
    const written = persistFullOptionChainSnapshots(SCAN_DIR, pending);
    for (const snapshot of pending) persistedFullChainCaptures.add(`${snapshot.session}:${snapshot.symbol}:${snapshot.capturedAt}`);
    // Once on disk, drop them from RAM — the timestamp-keyed Map otherwise
    // grows all session and OOMs the API. Keys match the provider's Map.
    provider.drainFullChainSnapshots?.(pending.map(snapshot => `${snapshot.symbol}:${snapshot.capturedAt}`));
    return written;
  } catch (error) {
    log('full-chain snapshot persistence failed:', String(error?.message || error));
    return 0;
  }
}

/** Read captured minutes from the existing raw index, falling back to the verified archive. */
async function readJournalMinute(date, hhmm) {
  let available = journalMinuteIndexes.get(date);
  if (!available) {
    const index = readMinutes(date);
    available = new Set((Array.isArray(index) ? index : []).map(entry => String(entry?.[0] ?? '').padStart(4, '0')));
    journalMinuteIndexes.set(date, available);
  }
  if (available.has(hhmm)) {
    try { return JSON.parse(fs.readFileSync(path.join(SCAN_DIR, date, `${hhmm}.json`), 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  // Archived dates are deliberately NOT read here: one day's archive expands
  // to a ~400 MB JSON payload, and resolving a whole session through it OOMs
  // the API. The normal pass always runs at 15:40 while the raw minutes still
  // exist; a missed day is backfilled offline (see docs/JOURNAL_ARCHIVE.md).
  return null;
}

/**
 * The ORB scan for a market file: opening range + breakout state per symbol
 * from the persisted futures snapshots, gated by the morning's leading
 * sectors. Pure model, disk reads only — no new subscriptions or timers.
 */
function computeOrb(at, file) {
  const session = file?.date ?? getLatestTradingSessionDate(new Date(at));
  const scan = orbScan({
    session,
    now: at,
    series: file?.series ?? [],
    sectors: ORB_SECTORS,
    readSnapshot: symbol => {
      try { return readFutures(SCAN_DIR, session, symbol); } catch { return null; }
    },
  });
  orbState.last = scan;
  return scan;
}

// Daily history refresh chain (bhavcopy -> capture -> futures stats -> today-backfill).
// Shared so BOTH the live build loop and the post-close fast path can run it — the fast
// path returns before the in-build block, which is why tonight's backfill never fired.
function startHistoryRefreshChain(at) {
  if (historyState.running || !historyRefreshDue(at, historyState.lastRun)) return false;
  historyState.running = true;
  historyState.lastRun = istParts(at).date;
  log('history refresh starting (bhavcopy -> capture -> futures stats -> today-backfill)');
  void runHistoryRefresh({
    root: ROOT,
    at,
    log,
    run: (script, args) => new Promise(resolve => {
      const child = spawn(process.execPath, ['--max-old-space-size=6144', path.join(ROOT, script), ...args], { cwd: ROOT, stdio: 'ignore' });
      child.on('exit', code => resolve(code ?? -1));
      child.on('error', () => resolve(-1));
    }),
    todayBackfill: () => historyRefreshTodayBackfill(at),
  })
    .then(result => log(formatHistoryRefreshSummary(result.results)))
    .catch(error => log('history refresh failed:', String(error?.message || error)))
    .finally(() => { historyState.running = false; });
  return true;
}

// Duplicate-content guard (2026-11-25 owner report: same SL/TGT and EOD-watchlist
// messages repeating across restarts and days). One Set of content hashes per day:
// an identical body sent again the same day is dropped, whichever path produced it.
// Persisted so an evening restart cannot replay the day's messages either.
const sentMessageHashPath = path.join(DATA_DIR, 'telegram-sent-hashes.json');
const dayKeyFor = at => new Date(at).toISOString().slice(0, 10);
let sentHashes = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(sentMessageHashPath, 'utf8'));
    if (parsed?.dayKey === dayKeyFor(Date.now()) && Array.isArray(parsed.hashes)) return new Set(parsed.hashes);
  } catch { /* fresh day or first boot */ }
  return new Set();
})();
function contentSeen(text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
  if (sentHashes.has(hash)) return true;
  sentHashes.add(hash);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(sentMessageHashPath, JSON.stringify({ dayKey: dayKeyFor(Date.now()), hashes: [...sentHashes].slice(-500) }));
  } catch { /* guard must never break sending */ }
  return false;
}

async function sendOwnerAndSubscribers(text, { parseMode } = {}) {
  if (contentSeen(text)) { log('telegram duplicate suppressed:', text.slice(0, 60).replace(/\n/g, ' ')); return { sent: false, duplicate: true }; }
  let sent = false;
  const ownerOptions = parseMode ? { parseMode } : undefined;
  try { sent = (await sendTelegram(`${text}\n\n${OWNER_DISCLAIMER}`, ownerOptions)).sent === true; }
  catch (error) { log('telegram owner message failed:', String(error?.message || error)); }
  const ownerId = process.env.TELEGRAM_CHAT_ID == null ? null : String(process.env.TELEGRAM_CHAT_ID);
  for (const chatId of activeChatIds(loadSubscribers(SUBSCRIBERS_PATH))) {
    if (String(chatId) === ownerId) continue;
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      const result = await sendTelegram(`${text}\n\n${BROADCAST_FOOTER}`, { chatId, ...(parseMode ? { parseMode } : {}) });
      sent ||= result.sent === true;
    } catch (error) {
      log(`telegram subscriber message ${chatId} failed:`, String(error?.message || error));
    }
  }
  return { sent };
}

// Level-hit alerts: each OPEN card's live premium is checked on every market rebuild;
// SL / TGT1 / TGT2 crossings fire exactly once per card+level per session. The fired
// set is PERSISTED (owner 2026-11-27: "dont send in loop") — the day had 5+ restarts
// and every restart wiped the in-memory set, re-firing the same hits with a slightly
// different premium (which also slipped past the content-hash dedupe).
const levelHitsFiredPath = path.join(DATA_DIR, 'level-hits-fired.json');
let levelHitsDayKey = dayKeyFor(Date.now());
const levelHitsFired = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(levelHitsFiredPath, 'utf8'));
    if (saved?.dayKey === dayKeyFor(Date.now()) && Array.isArray(saved.keys)) return new Set(saved.keys);
  } catch { /* new day or first boot */ }
  return new Set();
})();
function persistLevelHit(fireKey) {
  levelHitsFired.add(fireKey);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(levelHitsFiredPath, JSON.stringify({ dayKey: dayKeyFor(Date.now()), keys: [...levelHitsFired].slice(-800) }));
  } catch { /* persistence must never break sending */ }
}
async function checkLevelHits(session, at) {
  // Alerts are a market-hours feature: after close the LTP freezes and a restart
  // clears the fired-set — without this guard every refixed level re-fires at night.
  // NSE-only guard (owner 2026-11-27): MCX-evening hours kept this check
  // alive and it fired SL hits off FROZEN NSE premiums at 21:10 IST.
  if (!isMarketSessionTime(at, 'NSE')) return;
  try {
    const store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'observations.json'), 'utf8'));
    const cards = (store.cards ?? []).filter(c => c.date === session && (!c.outcome || c.outcome.status === 'open'));
    const ist = new Date(at + 330 * 60_000).toTimeString().slice(0, 5);
    for (const card of cards) {
      if (typeof card.expiry !== 'string' || !Number.isFinite(card.entry)) continue;
      const optionKey = `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
      const ltp = provider.ticksFor?.({ symbols: [], options: [{ symbol: card.symbol, strike: card.strike, side: card.side, expiry: card.expiry }] })?.options?.[optionKey]?.ltp;
      if (!Number.isFinite(ltp)) continue;
      for (const [key, label, icon] of [['sl', 'SL HIT', '🔻'], ['tgt1', 'TGT1 HIT', '🎯'], ['tgt2', 'TGT2 HIT', '🏁']]) {
        const fireKey = `${card.id}|${key}`;
        if (levelHitsFired.has(fireKey)) continue;
        const hit = key === 'sl' ? ltp <= card.sl : ltp >= card[key];
        if (!Number.isFinite(card[key]) || !hit) continue;
        persistLevelHit(fireKey);
        await sendOwnerAndSubscribers(
          `${icon} <b>${label}</b> — ${card.symbol} ${card.strike}${card.side}\nPremium ₹${ltp.toFixed(2)} · level ₹${Number(card[key]).toFixed(2)} · entry ₹${Number(card.entry).toFixed(2)} · ${ist} IST`,
          { parseMode: 'HTML' }
        );
      }
    }
  } catch (error) { log('level-hit check failed:', String(error?.message || error)); }
}

/** The newest stored minute snapshot for a session, or null when nothing was captured. */
function lastStoredMinuteFile(session) {
  const dir = path.join(SCAN_DIR, session);
  let index;
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); }
  catch { return null; }
  if (!Array.isArray(index) || !index.length) return null;
  const [hhmm, at] = index[index.length - 1];
  try {
    const json = fs.readFileSync(path.join(dir, `${hhmm}.json`), 'utf8');
    const file = JSON.parse(json);
    return { file, json, at, count: Array.isArray(file.series) ? file.series.length : 0 };
  } catch { return null; }
}

/** Reuse the prior session's captured closing OI when the current row lacks prevOi. */
async function previousSessionOiBaseline(sessionDate) {
  if (previousOiSessionDate === sessionDate) return previousOiBaseline;
  const sessionNoon = Date.parse(`${sessionDate}T12:00:00+05:30`);
  if (!Number.isFinite(sessionNoon)) return new Map();
  const previousDate = marketParts(getPreviousTradingDay(1, new Date(sessionNoon))).dateKey;
  const isClosingCapture = snapshot => {
    if (!Number.isFinite(snapshot?.t)) return false;
    const parts = marketParts(snapshot.t);
    const close = marketCloseMinuteFor(snapshot.t);
    return parts.dateKey === previousDate && parts.minuteOfDay >= close - 5 && parts.minuteOfDay <= close;
  };
  const stored = lastStoredMinuteFile(previousDate)?.file ?? null;
  let snapshot = isClosingCapture(stored) ? stored : null;
  if (!snapshot) {
    const previousNoon = Date.parse(`${previousDate}T12:00:00+05:30`);
    const closeMinute = Number.isFinite(previousNoon) ? marketCloseMinuteFor(previousNoon) : 15 * 60 + 40;
    for (let minute = closeMinute; minute >= Math.max(9 * 60 + 15, closeMinute - 5); minute--) {
      const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}${String(minute % 60).padStart(2, '0')}`;
      try {
        const candidate = await readJournalMinute(previousDate, hhmm);
        if (isClosingCapture(candidate) && Array.isArray(candidate.series)) { snapshot = candidate; break; }
      } catch (error) {
        log(`previous OI snapshot read failed for ${previousDate}: ${String(error?.message || error)}`);
        return new Map();
      }
    }
  }
  if (!snapshot) return new Map();
  previousOiBaseline = capturePreviousOiBaseline(snapshot);
  previousOiSessionDate = sessionDate;
  return previousOiBaseline;
}

export function encodeMcxFutureSeries(underlying, futures, liveTick, at, session) {
  const near = (Array.isArray(futures?.months) ? futures.months : [])
    .filter(month => typeof month?.date === 'string' && month.date >= session)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!near) return null;
  const candles = (Array.isArray(near.candles) ? near.candles : [])
    .filter(candle => Number.isSafeInteger(candle?.at) && Number.isFinite(candle?.close) && candle.close > 0)
    .sort((a, b) => a.at - b.at);
  const last = candles.at(-1);
  const liveLtp = Number(liveTick?.ltp);
  const spot = Number.isFinite(liveLtp) && liveLtp > 0 ? liveLtp : last?.close;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const previousClose = Number(near.prevClose ?? last?.prevClose);
  const quoteAt = Number.isSafeInteger(liveTick?.at) ? liveTick.at : last?.at;
  const encoded = encodeSeries(underlying, {
    spot,
    prevClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    expiry: near.date,
    at: quoteAt,
    strikes: [],
  }, at);
  return encoded ? {
    ...encoded,
    exchange: 'MCX',
    segment: 'MCX_COMM',
    securityId: near.securityId ?? underlying.securityId ?? null,
    instrument: near.instrument ?? 'FUTCOM',
  } : null;
}

async function build() {
  if (state.building) return;
  state.building = true;
  const started = Date.now();
  const clock = now();
  const nseOpen = provider.alwaysLive || isMarketSessionTime(clock, 'NSE');
  const mcxOpen = provider.id === 'dhan' && isMarketSessionTime(clock, 'MCX');
  const mcxSessionInfo = sessionFor('MCX', clock);
  const mcxSessionDate = mcxSessionInfo.dateKey;
  const mcxAfterClose = provider.id === 'dhan'
    && isTradingDay(clock, 'MCX')
    && marketParts(clock).minuteOfDay > mcxSessionInfo.closeMinute;
  const nseSessionDate = getLatestTradingSessionDate(new Date(clock));
  const session = !nseOpen && (mcxOpen || mcxAfterClose) ? mcxSessionDate : nseSessionDate;
  pcrHistory.resetForSession(session);
  // Fired-set clears ONLY on a calendar-day change (owner 2026-11-27 loop fix):
  // the old unconditional clear() ran on EVERY build pass and wiped the
  // persisted set seconds after boot — SL/TGT alerts re-fired forever.
  const firedToday = dayKeyFor(clock);
  if (levelHitsDayKey !== firedToday) {
    levelHitsDayKey = firedToday;
    levelHitsFired.clear();
    try { fs.writeFileSync(levelHitsFiredPath, JSON.stringify({ dayKey: firedToday, keys: [] })); } catch { /* best-effort */ }
  }
  // Post-close fast path: the market is shut and nothing is moving — serve the
  // session's last built snapshot (the real closing state, written by every
  // successful build) instead of crawling 215 chains through the paced REST
  // fallback. A fresh session day starts empty and builds live.
  if (!provider.alwaysLive && !nseOpen && !mcxOpen) {
    const stored = storedSessionSnapshot(SCAN_DIR, session);
    if (stored) {
      state.latest = stored.file;
      state.latestJson = stored.json;
      state.lastBuild = { at: stored.at, ms: Date.now() - started, series: stored.count, failed: 0, failedSymbols: [], firstError: null };
      state.lastError = null;
      log(`market file: ${stored.count} series (stored session snapshot — market closed), 0 failed, ${Date.now() - started} ms`);
      // The journal's gate is 15:40 — by then this fast path owns every build,
      // so the pass must run here too or outcomes never resolve at all.
      void runJournal({
        obsPath: path.join(DATA_DIR, 'observations.json'),
        readMinute: readJournalMinute,
        now: clock,
        log,
        send: process.env.TELEGRAM_BOT_TOKEN ? sendOwnerAndSubscribers : undefined,
      }).catch(error => log('journal failed:', String(error?.message || error)));
      if (mcxAfterClose) queueClosedSessionArchives(session, clock);
      state.building = false;
      // The post-close fast path returns before the in-build history-refresh block,
      // so the chain is triggered here too — this is what runs tonight-backfill.
      startHistoryRefreshChain(clock);
      return;
    }
  }
  if (ladderCache.session !== session) { ladderCache.session = session; ladderCache.bySymbol.clear(); }
  const activeUniverse = universe.filter(underlying => {
    if (isMcxUnderlying(underlying)) return mcxOpen;
    return nseOpen;
  });
  const buildUniverse = activeUniverse.length ? activeUniverse : universe.filter(underlying => !isMcxUnderlying(underlying));
  const carriedMarket = mcxOpen && !nseOpen ? lastStoredMinuteFile(session)?.file : null;
  const carriedSeries = (carriedMarket?.series ?? []).filter(row => !isMcxUnderlying(bySymbol.get(row.s)));
  const carriedLadders = carriedMarket?.ladders ?? {};
  const series = [];
  const ladders = {};
  const failed = [];
  let firstError = null;
  let nextChainFailures = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < buildUniverse.length) {
      const u = buildUniverse[cursor++];
      try {
        if (isMcxUnderlying(u)) {
          const futures = await futuresFor(u.symbol, session);
          const liveTick = provider.ticksFor?.({ symbols: [u.symbol] })?.futures?.[u.symbol] ?? null;
          const encoded = encodeMcxFutureSeries(u, futures, liveTick, now(), session);
          ladders[u.symbol] = (futures?.months ?? []).filter(month => month.date >= session).slice(0, 1).map(month => month.date);
          if (encoded) series.push(encoded); else failed.push(u.symbol);
          continue;
        }
        let ladder = ladderCache.bySymbol.get(u.symbol);
        if (!ladder) {
          ladder = await provider.expiries(u);
          if (ladder.length) ladderCache.bySymbol.set(u.symbol, ladder);
        }
        const live = filterLiveExpiries(ladder, clock);
        ladders[u.symbol] = live;
        if (!live[0]) continue;
        const chain = await provider.optionChain(u, live[0]);
        // December block: the next expiry rides along when captured. A next
        // chain that fails must NOT fail the symbol — near chain wins, the
        // series just omits `next` this build.
        let nextChain = null;
        if (live[1]) {
          try {
            const candidate = await provider.optionChain(u, live[1]);
            if (candidate?.spot > 0 && Array.isArray(candidate.strikes) && candidate.strikes.length) {
              nextChain = { ...candidate, expiry: candidate.expiry || live[1] };
            }
          } catch {
            nextChainFailures += 1;
          }
        }
        const encoded = encodeSeries(u, { ...chain, expiry: chain.expiry || live[0] }, now(), nextChain);
        if (encoded) series.push(encoded); else failed.push(u.symbol);
      } catch (error) {
        failed.push(u.symbol);
        firstError ??= String(error?.message || error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
    const fullChainsWritten = persistProviderFullChains();
    if (fullChainsWritten) log(`full-chain snapshots: ${fullChainsWritten} persisted, ${provider.fullChainSnapshotCount?.() ?? '?'} retained in RAM`);
    const capturedSeries = mcxOpen && !nseOpen ? [...carriedSeries, ...series] : series;
    const capturedLadders = mcxOpen && !nseOpen ? { ...carriedLadders, ...ladders } : ladders;
    if (!capturedSeries.length) throw new Error(firstError ? `No underlying answered: ${firstError}` : 'No underlying answered.');
    if (nextChainFailures) log(`next-expiry chains unavailable for ${nextChainFailures} symbol(s) this build — near-only series kept`);
    const at = now();
    const sorted = capturedSeries.sort((a, b) => a.s.localeCompare(b.s));
    const rawFile = marketFile({ at, date: session, series: sorted, minutes: [], ladders: capturedLadders });
    let previousOi = new Map();
    if (nseOpen) {
      try { previousOi = await previousSessionOiBaseline(session); }
      catch (error) { log(`previous OI baseline unavailable for ${session}: ${String(error?.message || error)}`); }
    }
    const enriched = nseOpen ? fillMissingPrevOi(rawFile, previousOi) : { market: rawFile, filled: 0 };
    if (enriched.filled) log(`OI baseline: restored ${enriched.filled} captured contract row(s) from the previous session`);
    if (nseOpen) pcrHistory.record(enriched.market.series, at);
    // Only a reading taken in session is a minute the windows can measure from.
    const minutes = isMarketSessionTime(at, 'NSE') || (provider.id === 'dhan' && isMarketSessionTime(at, 'MCX'))
      ? storeMinute(session, at, JSON.stringify(enriched.market))
      : readMinutes(session);
    const file = { ...enriched.market, minutes };
    state.latest = file;
    if (nseOpen) checkLevelHits(session, at)?.catch?.(() => {});
    state.latestJson = JSON.stringify(file);
    fs.mkdirSync(SCAN_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCAN_DIR, 'latest.json'), state.latestJson);
    if (!mcxOpen) queueClosedSessionArchives(session, at);
    state.lastBuild = { at, ms: Date.now() - started, series: capturedSeries.length, failed: failed.length, failedSymbols: failed.slice(0, 20), firstError };
    state.lastError = null;
    log(`market file: ${capturedSeries.length} series, ${failed.length} failed, ${Date.now() - started} ms${firstError ? ` (first error: ${firstError})` : ''}`);
    if (nseOpen && process.env.TELEGRAM_BOT_TOKEN && isTradingDay(at)) {
      const gapDate = gapOpenDue(at, alertDigestState.gapOpenDay ?? null);
      if (gapDate) {
        alertDigestState.gapOpenDay = gapDate;
        const gapMessage = gapOpenMessage(file, gapDate);
        if (gapMessage) void sendOwnerAndSubscribers(gapMessage, { parseMode: 'HTML' }).catch(error => log('gap-open message failed:', String(error?.message || error)));
      }
    }
    if (nseOpen) {
      try {
        const subscriberState = process.env.TELEGRAM_BOT_TOKEN ? loadSubscribers(SUBSCRIBERS_PATH) : { subscribers: [], offset: 0 };
        const broadcastChatIds = activeChatIds(subscriberState);
        const fired = await runAlerts(file, {
          rulesPath: path.join(DATA_DIR, 'alerts.json'),
          state: alertState,
          digestState: alertDigestState,
          now: at,
          log,
          broadcastChatIds,
          subscriberEntries: subscriberState.subscribers,
        });
        if (fired.length) log(`alerts fired: ${fired.length}`);
      } catch (error) {
        log('alerts failed:', String(error?.message || error));
      }
    }
    // ORB pushes: one at 09:35 and one at 10:05 IST, day-keyed. Evaluation rides
    // this build loop — no extra timer, no extra subscriptions.
    if (nseOpen && process.env.TELEGRAM_BOT_TOKEN && file?.series?.length) {
      if (orbState.session !== session) { orbState.session = session; orbState.sent = new Set(); }
      const slot = orbSlotDue(at, orbState.sent);
      if (slot) {
        try {
          const scan = computeOrb(at, file);
          orbState.sent.add(slot);
          await sendOwnerAndSubscribers(orbMessage(scan.rows, { slot, date: session }), { parseMode: 'HTML' });
          log(`orb push ${slot}: ${scan.counts.breakouts} breakout(s), ${scan.counts.extended} extended, ${scan.counts.building} still building`);
        } catch (error) {
          log('orb push failed:', String(error?.message || error));
        }
      }
    }
    // Token-expiry reminder: owner-only, once per level per session. The server
    // keeps the token it read at boot, so this is the only warning before 401s.
    if (nseOpen && process.env.TELEGRAM_BOT_TOKEN && isTradingDay(at)) {
      const reminder = tokenReminder({ expiresAt: provider.health?.()?.tokenExpiresAt ?? null, now: at });
      const key = reminder && `${session}|${reminder.level}`;
      if (reminder && tokenWatch.sentFor !== key) {
        tokenWatch.sentFor = key;
        try {
          const result = await sendTelegram(reminder.text, { parseMode: 'HTML' });
          log(`dhan token ${reminder.level} reminder ${result?.sent ? 'sent' : 'not sent'} (${reminder.hoursLeft}h left)`);
        } catch (error) {
          log('dhan token reminder failed:', String(error?.message || error));
        }
      }
    }
    // Daily history refresh: the bhavcopy publishes in the evening, so this
    // fires once after 19:30 IST and never blocks a build — each step is its
    // own child process with its own heap.
    startHistoryRefreshChain(at);
    // Throttled to TYPESAFE_TRIAGE_MIN (default 10); never blocks or fails the build.
    if (nseOpen) runTriage(file, { autoPath: path.join(DATA_DIR, 'alerts.auto.json'), now: at, log })
      .then(result => {
        if (result.written != null) log(`triage: ${result.written} watch rule(s)${result.watches.length ? ` (${result.watches.map(w => w.symbol).join(' ')})` : ''}`);
        else if (result.skipped && result.skipped !== 'throttled') log(`triage skipped: ${result.skipped}`);
        // Observation cards for the promoted watches — same cadence, fire-and-forget.
        if (result.watches?.length) {
          return runAdvisor(file, {
            obsPath: path.join(DATA_DIR, 'observations.json'),
            watches: result.watches,
            now: at,
            log,
            readFuturesSnapshot: (symbol, date) => readFutures(SCAN_DIR, date, symbol),
            pcrShiftFor: (symbol, timestamp) => pcrHistory.shiftFor(symbol, timestamp),
            sectorFor: symbol => ORB_SECTORS.get(symbol) ?? null,
            subscriberChatIds: activeChatIds(loadSubscribers(SUBSCRIBERS_PATH)),
            getLive: card => {
              try {
                const spots = provider.spots?.() ?? {};
                const ticks = provider.ticksFor?.({
                  symbols: [card.symbol],
                  options: [{ symbol: card.symbol, strike: card.strike, side: card.side, expiry: card.expiry }],
                }) ?? { futures: {}, options: {} };
                const optionKey = `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
                return {
                  spot: spots[card.symbol]?.ltp,
                  future: ticks.futures?.[card.symbol]?.ltp,
                  option: ticks.options?.[optionKey]?.ltp,
                };
              } catch { return null; }
            },
          })
            .then(advisor => { if (advisor.written != null && advisor.written) log(`advisor: ${advisor.written} observation card(s) (${advisor.cards.map(c => `${c.symbol} ${c.strike}${c.side}`).join(' ')})`); })
            .catch(error => log('advisor failed:', String(error?.message || error)));
        }
      })
      .catch(error => log('triage failed:', String(error?.message || error)));
    if (mcxOpen) void runMcxCards(file, {
      obsPath: path.join(DATA_DIR, 'observations.json'),
      date: session,
      now: at,
      readFuturesSnapshot: (symbol, date) => readFutures(SCAN_DIR, date, symbol),
      subscriberChatIds: activeChatIds(loadSubscribers(SUBSCRIBERS_PATH)),
      send: process.env.TELEGRAM_BOT_TOKEN ? sendOwnerAndSubscribers : undefined,
      log,
    }).then(result => { if (result.written) log(`mcx advisor: ${result.written} MCX card(s) (${result.cards.map(c => c.symbol).join(' ')})`); })
      .catch(error => log('mcx advisor failed:', String(error?.message || error)));
    if (nseOpen || mcxOpen) void runJournal({
      obsPath: path.join(DATA_DIR, 'observations.json'),
      readMinute: readJournalMinute,
      readFuturesSnapshot: (symbol, date) => readFutures(SCAN_DIR, date, symbol),
      now: at,
      log,
      send: process.env.TELEGRAM_BOT_TOKEN ? sendOwnerAndSubscribers : undefined,
    }).catch(error => log('journal failed:', String(error?.message || error)));
  } catch (error) {
    // The detail (which may quote the provider's own error) stays in this log; the page gets a plain line.
    log('market file failed:', String(error?.message || error));
    state.lastError = { at: Date.now(), message: 'The data provider did not answer. The server log has the detail.' };
  } finally {
    state.building = false;
  }
}

/**
 * Live sessions build once per minute. Idle sleep stops before the next NSE or
 * MCX open, so an MCX-only evening session keeps using the same Dhan instance.
 */
function schedule() {
  const now = Date.now();
  const nseLive = provider.alwaysLive || isMarketSessionTime(now, 'NSE');
  const mcxLive = provider.id === 'dhan' && isMarketSessionTime(now, 'MCX');
  const live = nseLive || mcxLive;
  let wait;
  if (live) {
    wait = 60_000 - (now % 60_000) + 3_000;
  } else {
    const IST = 5.5 * 60 * 60_000;
    const midnightUtc = Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
    const nextOpen = exchange => {
      for (let dayOffset = 0; dayOffset < 15; dayOffset++) {
        const day = midnightUtc + dayOffset * 86_400_000;
        const open = day + sessionFor(exchange, day + 12 * 60 * 60_000).openMinute * 60_000 + 3_000;
        if (open > now && isTradingDay(open, exchange)) return open;
      }
      return Infinity;
    };
    const open = Math.min(nextOpen('NSE'), provider.id === 'dhan' ? nextOpen('MCX') : Infinity);
    wait = Math.min(3_600_000, Math.max(60_000, open - now));
  }
  setTimeout(async () => { await build(); schedule(); }, wait);
}

// ── Futures, on demand ──────────────────────────────────────────────────────

const futuresCache = new Map();
let futuresActive = 0;
let archiveLock = 'open';
const yieldToLoop = () => new Promise(resolve => setTimeout(resolve, 10));

export async function loadFuturesWithArchiveLock(lock, load, persist, logger = () => {}) {
  const result = await load();
  if (lock !== 'sealed') {
    try { await persist(result); }
    catch (error) { logger(error); }
  }
  return result;
}

/**
 * The stored session snapshot behind the post-close fast path: SCAN_DIR's
 * latest.json, only when it IS the active session's and holds series. A file
 * from an earlier session returns null so a fresh day still builds live.
 */
export function storedSessionSnapshot(dir, session) {
  try {
    const json = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8');
    const file = JSON.parse(json);
    if (file?.date === session && Array.isArray(file.series) && file.series.length) {
      return { file, json, at: file.t, count: file.series.length };
    }
  } catch { /* unreadable → the caller falls through to the live crawl */ }
  return null;
}

/**
 * The /api/health payload: what an outside monitor needs, built from state
 * alone — it never calls the provider chain. A provider without a health
 * surface (demo, recorded) reports no rejection and no known feed problem.
 */
export function healthPayload(provider, state, capture, now = Date.now(), bootedAt = BOOTED_AT) {
  let feed = { healthy: true, packets: null, lastPacketAt: null, connections: null, futuresFlush: null };
  let tokenState = 'ok';
  let tokenExpiresAt = null;
  try {
    const health = typeof provider?.health === 'function' ? provider.health() : null;
    if (health) {
      feed = {
        healthy: Boolean(health.healthy),
        packets: Number.isFinite(health.packets) ? health.packets : null,
        lastPacketAt: Number.isFinite(health.lastPacketAt) ? health.lastPacketAt : null,
        connections: health.connections ?? null,
        futuresFlush: health.futuresFlush && typeof health.futuresFlush === 'object' ? {
          flushCount: Number.isSafeInteger(health.futuresFlush.flushCount) ? Math.max(0, health.futuresFlush.flushCount) : 0,
          lastFlushAt: Number.isFinite(health.futuresFlush.lastFlushAt) ? health.futuresFlush.lastFlushAt : null,
          lastError: typeof health.futuresFlush.lastError === 'string' ? health.futuresFlush.lastError : null,
          lastErrorAt: Number.isFinite(health.futuresFlush.lastErrorAt) ? health.futuresFlush.lastErrorAt : null,
        } : null,
      };
      if (health.flowing !== undefined) feed.flowing = Boolean(health.flowing);
      tokenState = health.tokenState === 'rejected' ? 'rejected' : 'ok';
      if (Number.isFinite(health.tokenExpiresAt)) tokenExpiresAt = health.tokenExpiresAt;
    }
  } catch { /* a broken provider read must not break health */ }
  return {
    provider: provider?.id ?? null,
    uptimeSeconds: Math.max(0, Math.round((now - bootedAt) / 1000)),
    lastBuild: state.lastBuild && { at: state.lastBuild.at, series: state.lastBuild.series, failed: state.lastBuild.failed },
    lastError: state.lastError && { at: state.lastError.at, message: state.lastError.message },
    ...withCaptureStatus({}, capture),
    feed,
    tokenState,
    token: { expiresAt: tokenExpiresAt, hoursLeft: hoursLeft(tokenExpiresAt, now) },
  };
}

/**
 * Strike-level momentum series for one or more underlyings, read off stored
 * minute snapshots (schema-1 market files, ascending). Only strikes within
 * `windowPct` of each symbol's last spot are kept — nearest ATM first when
 * past `cap` — so the payload stays a few hundred KB. Strike keys carry the
 * symbol (`NIFTY|25150|CE`) and spot/prev-close are per-symbol maps, so a
 * combined three-index board reads each index fairly.
 */
export function strikeFlowFromFiles(files, symbols, { windowPct = 0.05, cap = 64 } = {}) {
  const wanted = (Array.isArray(symbols) ? symbols : [symbols]).map(s => String(s).toUpperCase());
  const spot = Object.fromEntries(wanted.map(s => [s, []]));
  const spotPrevClose = Object.fromEntries(wanted.map(s => [s, null]));
  const expiries = {};
  const strikes = new Map();
  let date = null;
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    for (const symbol of wanted) {
      const series = (file.series ?? []).find(item => item?.s === symbol);
      if (!series || !Array.isArray(series.r)) continue;
      if (Number.isFinite(series.sp) && series.sp > 0) spot[symbol].push([file.t, series.sp]);
      if (!expiries[symbol] && typeof series.e === 'string') expiries[symbol] = series.e;
      if (!date && typeof file.date === 'string') date = file.date;
      // The underlying's previous close rides on every snapshot; the day window
      // and the spot reference line quote it instead of the first capture.
      if (spotPrevClose[symbol] == null && Number.isFinite(series.pc) && series.pc > 0) spotPrevClose[symbol] = series.pc;
      for (const row of series.r) {
        if (!Array.isArray(row) || row.length < 7) continue;
        // Row order is parseRow's contract: strike, side, ltp, prevClose, oi, prevOi, volume.
        const [strike, side, ltp, prevClose, oi, prevOi, volume] = row;
        if (!Number.isFinite(strike) || (side !== 0 && side !== 1) || !Number.isFinite(ltp)) continue;
        const sideCode = side === 0 ? 'CE' : 'PE';
        const key = `${symbol}|${strike}|${sideCode}`;
        const held = strikes.get(key) ?? { symbol, strike, side: sideCode, series: [], prevClose: null, prevOi: null };
        held.series.push([file.t, ltp, Number.isFinite(oi) ? oi : null, Number.isFinite(volume) ? volume : null, Number.isFinite(row[9]) ? row[9] : null]);
        if (held.prevClose == null && Number.isFinite(prevClose) && prevClose > 0) held.prevClose = prevClose;
        if (held.prevOi == null && Number.isFinite(prevOi) && prevOi >= 0) held.prevOi = prevOi;
        strikes.set(key, held);
      }
    }
  }
  const out = {};
  for (const symbol of wanted) {
    const lastSpot = spot[symbol].at(-1)?.[1] ?? null;
    let kept = [...strikes.values()].filter(item => item.symbol === symbol);
    if (lastSpot) {
      kept = kept.filter(item => Math.abs(item.strike - lastSpot) / lastSpot <= windowPct);
      kept.sort((a, b) => Math.abs(a.strike - lastSpot) - Math.abs(b.strike - lastSpot));
      kept = kept.slice(0, cap);
    }
    for (const item of kept) {
      const last = item.series.at(-1);
      out[`${item.symbol}|${item.strike}|${item.side}`] = {
        symbol: item.symbol, strike: item.strike, side: item.side,
        expiry: expiries[item.symbol] ?? null,
        prevClose: item.prevClose, prevOi: item.prevOi,
        ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null, iv: last?.[4] ?? null,
        spotDistancePct: lastSpot ? ((item.strike - lastSpot) / lastSpot) * 100 : null,
        series: item.series,
      };
    }
  }
  return { symbols: wanted, symbol: wanted[0], date, expiry: expiries, spot, spotPrevClose, strikes: out, minuteCount: files.length };
}

/** The as-of cut for replay: every series stops at the cursor and the "last"
 * readings are recomputed from what survived — the payload never quotes a
 * moment it does not show. */
export function truncateStrikeFlow(payload, cursor) {
  const spot = Object.fromEntries(Object.entries(payload.spot).map(([symbol, points]) => [symbol, points.filter(([t]) => t <= cursor)]));
  return {
    ...payload,
    spot,
    strikes: Object.fromEntries(Object.entries(payload.strikes).map(([key, item]) => {
      const series = item.series.filter(([t]) => t <= cursor);
      const last = series.at(-1);
      const lastSpot = spot[item.symbol]?.at(-1)?.[1] ?? null;
      return [key, { ...item, series, ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null,
        iv: last?.[4] ?? null, spotDistancePct: lastSpot ? ((item.strike - lastSpot) / lastSpot) * 100 : null }];
    })),
  };
}

/**
 * Per-symbol incremental extraction. Entry: what one symbol has consumed so
 * far this session — appending only the minutes it has not seen makes every
 * scope switch instant, live included (a fresh minute costs one small parse,
 * never a re-read of the day).
 */
function extendSymbolEntry(entry, file) {
  const symbol = entry.symbol;
  const series = (file.series ?? []).find(item => item?.s === symbol);
  if (!series || !Array.isArray(series.r)) return;
  if (Number.isFinite(series.sp) && series.sp > 0) entry.spot.push([file.t, series.sp]);
  if (!entry.expiry && typeof series.e === 'string') entry.expiry = series.e;
  if (entry.spotPrevClose == null && Number.isFinite(series.pc) && series.pc > 0) entry.spotPrevClose = series.pc;
  for (const row of series.r) {
    if (!Array.isArray(row) || row.length < 7) continue;
    // Row order is parseRow's contract: strike, side, ltp, prevClose, oi, prevOi, volume.
    const [strike, side, ltp, prevClose, oi, prevOi, volume] = row;
    if (!Number.isFinite(strike) || (side !== 0 && side !== 1) || !Number.isFinite(ltp)) continue;
    const sideCode = side === 0 ? 'CE' : 'PE';
    const key = `${symbol}|${strike}|${sideCode}`;
    const held = entry.strikes.get(key) ?? { symbol, strike, side: sideCode, series: [], prevClose: null, prevOi: null };
    held.series.push([file.t, ltp, Number.isFinite(oi) ? oi : null, Number.isFinite(volume) ? volume : null]);
    if (held.prevClose == null && Number.isFinite(prevClose) && prevClose > 0) held.prevClose = prevClose;
    if (held.prevOi == null && Number.isFinite(prevOi) && prevOi >= 0) held.prevOi = prevOi;
    entry.strikes.set(key, held);
  }
  entry.minuteCount += 1;
}

/** Assemble the response payload from an entry: window filter + ATM cap per symbol. */
function assembleSymbolEntry(entry, { windowPct = 0.05, cap = 64 } = {}) {
  const lastSpot = entry.spot.at(-1)?.[1] ?? null;
  let kept = [...entry.strikes.values()];
  if (lastSpot) {
    kept = kept.filter(item => Math.abs(item.strike - lastSpot) / lastSpot <= windowPct);
    kept.sort((a, b) => Math.abs(a.strike - lastSpot) - Math.abs(b.strike - lastSpot));
    kept = kept.slice(0, cap);
  }
  const out = {};
  for (const item of kept) {
    const last = item.series.at(-1);
    out[`${item.symbol}|${item.strike}|${item.side}`] = {
      symbol: item.symbol, strike: item.strike, side: item.side,
      expiry: entry.expiry ?? null,
      prevClose: item.prevClose, prevOi: item.prevOi,
      ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null,
      spotDistancePct: lastSpot ? ((item.strike - lastSpot) / lastSpot) * 100 : null,
      series: item.series,
    };
  }
  return out;
}

const symbolFlowCache = new Map();
const SYMBOL_FLOW_CACHE_LIMIT = 40;
/** Parsed archive sessions, one at a time: a closed day is read once per burst, not per minute. */
const archiveSessionCache = new Map();

/**
 * One symbol's incremental entry for a session. Live minutes are consumed as
 * they arrive (each new minute is one small parse); a closed day comes from
 * one archive session read. `cursor` truncates the assembled payload to an
 * as-of instant without re-reading anything.
 */
async function loadSymbolEntry(date, symbol, minutes) {
  const key = `${date}|${symbol}`;
  let entry = symbolFlowCache.get(key) ?? null;
  const consumed = entry ? entry.minuteCount : 0;
  let total = minutes.length;
  let session = null;
  if (total === 0) {
    // Closed and archived: the raw day dir is pruned, so the source is one
    // archive session read (kept for the burst, then dropped).
    session = archiveSessionCache.get(date) ?? null;
    if (!session) {
      try { session = await archive.readSession(date); }
      catch (error) {
        if (error?.code !== 'ARCHIVE_MISSING') throw error;
        return null;
      }
      archiveSessionCache.set(date, session);
      if (archiveSessionCache.size > 2) archiveSessionCache.delete(archiveSessionCache.keys().next().value);
    }
    total = session.minutesIndex.length;
  }
  if (entry && consumed >= total) return entry;
  if (!entry) {
    entry = { symbol, date, minuteCount: 0, spot: [], spotPrevClose: null, expiry: null, strikes: new Map() };
    symbolFlowCache.set(key, entry);
    if (symbolFlowCache.size > SYMBOL_FLOW_CACHE_LIMIT) symbolFlowCache.delete(symbolFlowCache.keys().next().value);
  }
  for (let index = consumed; index < total; index++) {
    let file = null;
    if (session) {
      const [hhmm] = session.minutesIndex[index];
      const json = session.minutes[hhmm];
      if (json == null) continue;
      try { file = typeof json === 'string' ? JSON.parse(json) : json; }
      catch { continue; }
    } else {
      const [hhmm] = minutes[index];
      try { file = JSON.parse(fs.readFileSync(path.join(SCAN_DIR, date, `${hhmm}.json`), 'utf8')); }
      catch { continue; }
    }
    if (file) extendSymbolEntry(entry, file);
  }
  entry.minuteCount = total;
  return entry;
}

/**
 * One or more underlyings' strike flow for a session, assembled from
 * per-symbol incremental entries. Repeat scopes are instant; live minutes
 * append incrementally; `cursor` truncates to an as-of instant.
 */
async function strikeFlowFor(symbols, date, cursor = null) {
  const minutes = readMinutes(date);
  const strikes = {};
  const spot = {};
  const spotPrevClose = {};
  const expiry = {};
  let minuteCount = Infinity;
  let any = false;
  for (const symbol of symbols) {
    const entry = await loadSymbolEntry(date, symbol, minutes);
    if (!entry || entry.strikes.size === 0) continue;
    any = true;
    const lastSpot = entry.spot.at(-1)?.[1] ?? null;
    let kept = [...entry.strikes.values()];
    if (lastSpot) {
      kept = kept.filter(item => Math.abs(item.strike - lastSpot) / lastSpot <= 0.05);
      kept.sort((a, b) => Math.abs(a.strike - lastSpot) - Math.abs(b.strike - lastSpot));
      kept = kept.slice(0, 64);
    }
    for (const item of kept) {
      const last = item.series.at(-1);
      strikes[`${item.symbol}|${item.strike}|${item.side}`] = {
        symbol: item.symbol, strike: item.strike, side: item.side,
        expiry: entry.expiry ?? null,
        prevClose: item.prevClose, prevOi: item.prevOi,
        ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null,
        spotDistancePct: lastSpot ? ((item.strike - lastSpot) / lastSpot) * 100 : null,
        series: item.series,
      };
    }
    spot[symbol] = entry.spot;
    spotPrevClose[symbol] = entry.spotPrevClose;
    if (entry.expiry) expiry[symbol] = entry.expiry;
    minuteCount = Math.min(minuteCount, entry.minuteCount);
  }
  if (!any) return null;
  const payload = { symbols, symbol: symbols[0], date, expiry, spot, spotPrevClose, strikes, minuteCount: minuteCount === Infinity ? 0 : minuteCount };
  return cursor ? truncateStrikeFlow(payload, cursor) : payload;
}

async function futuresFor(symbol, session) {
  const key = `${symbol}|${session}`;
  const held = futuresCache.get(key);
  const cacheAt = Date.now();
  const live = provider.alwaysLive || isMarketSessionTime(cacheAt, 'NSE')
    || (provider.id === 'dhan' && isMarketSessionTime(cacheAt, 'MCX'));
  if (held && (!live || Date.now() - held.at < FUTURES_KEEP_MS)) return held.value;
  // Closed-market fast path: the persisted session file IS the final state —
  // serve it from disk instantly instead of pacing REST calls per symbol.
  if (!live) {
    try {
      const stored = readFutures(SCAN_DIR, session, symbol);
      if (stored && Array.isArray(stored.months) && stored.months.length) {
        const result = { symbol: stored.symbol, session: stored.session, months: stored.months };
        futuresCache.set(key, { at: Date.now(), value: Promise.resolve(result) });
        return result;
      }
    } catch { /* corrupt or missing → fall through to the provider */ }
  }
  // MCX disk-first (owner 2026-11-27: /api/futures/GOLD hung 40s behind a Dhan
  // 429 rest while 8 good candles sat on disk). The capture pass persists the
  // MCX futures file every minute, so serving it instantly costs at most one
  // minute of staleness — never a hang. NSE/BSE keep the live crawl.
  if (bySymbol.get(symbol)?.exch === 'MCX') {
    try {
      const stored = readFutures(SCAN_DIR, session, symbol);
      if (stored && Array.isArray(stored.months) && stored.months.length && (stored.months[0]?.candles ?? []).length) {
        const result = { symbol: stored.symbol, session: stored.session, months: stored.months };
        futuresCache.set(key, { at: Date.now(), value: Promise.resolve(result) });
        return result;
      }
    } catch { /* no file yet → normal provider path */ }
  }
  futuresActive += 1;
  const value = (async () => {
    try {
      return await loadFuturesWithArchiveLock(
        archiveLock,
        () => Promise.resolve(provider.futures(bySymbol.get(symbol), session)).then(months => ({ symbol, session, months })),
        result => Promise.resolve().then(() => persistFutures(SCAN_DIR, session, symbol, result)),
        error => log(`futures ${symbol} persistence failed:`, error?.message || error),
      );
    } finally {
      futuresActive -= 1;
    }
  })();
  futuresCache.set(key, { at: Date.now(), value });
  value.catch(() => futuresCache.delete(key));
  if (futuresCache.size > 4000) futuresCache.delete(futuresCache.keys().next().value);
  return value;
}

const capture = createCapture({
  provider,
  universe,
  futuresFor,
  logger: (...args) => log(...args),
});

// Boot warm pass: pre-fill the futures cache so the page opens fully populated
// (no "Updating · futures 0 of N" phase while backfills trickle in). Fired AFTER
// provider.init() — the instrument map must exist first. The provider's own
// throttle paces the calls; failures retry on demand.
async function futuresWarmPass() {
  try {
    const at = now();
    const nseSession = getLatestTradingSessionDate(new Date(at));
    const mcxSession = sessionFor('MCX', at).dateKey;
    let warmed = 0;
    for (const u of universe) {
      const mcx = isMcxUnderlying(u);
      if (mcx && (provider.id !== 'dhan' || !isTradingDay(at, 'MCX'))) continue;
      const session = mcx ? mcxSession : nseSession;
      try { await futuresFor(u.symbol, session); warmed += 1; }
      catch (error) { log(`warm pass ${u.symbol} failed:`, String(error?.message || error).slice(0, 120)); }
    }
    log(`futures warm pass: ${warmed}/${universe.length} symbols cached`);
    if (typeof provider.backfillTodayFutures === 'function') {
      const mcxMinute = marketParts(at).minuteOfDay;
      const mcxOpen = provider.id === 'dhan' && isMarketSessionTime(at, 'MCX');
      const mcxPostClose = provider.id === 'dhan' && isTradingDay(at, 'MCX') && mcxMinute > sessionFor('MCX', at).closeMinute;
      const backfillJobs = [
        { exchange: 'NSE', session: nseSession, symbols: universe.filter(u => !isMcxUnderlying(u)), run: isMarketSessionTime(at, 'NSE'), postClose: false },
        { exchange: 'MCX', session: mcxSession, symbols: universe.filter(isMcxUnderlying), run: mcxOpen || mcxPostClose, postClose: !mcxOpen },
      ];
      for (const job of backfillJobs) {
        if (!job.run || !job.symbols.length) continue;
        const backfill = await provider.backfillTodayFutures(job.session, {
          symbols: job.symbols.map(u => u.symbol), exchange: job.exchange, postClose: job.postClose,
        });
        let persisted = 0;
        for (const update of backfill?.updates ?? []) {
          const updateSession = update.session ?? job.session;
          try {
            let persistedSnapshot = null;
            const stored = await loadFuturesWithArchiveLock(
              archiveLock,
              () => Promise.resolve(update),
              result => Promise.resolve().then(() => {
                // REST fallback fills missing MCX/NSE fields while retaining feed close/OI.
                persistedSnapshot = persistFutures(SCAN_DIR, updateSession, update.symbol, result, { preferIncomingCloseOi: false });
                return persistedSnapshot;
              }),
              error => log(`boot ${job.exchange} today backfill ${update.symbol} persistence failed:`, error?.message || error),
            );
            if (!stored) continue;
            futuresCache.set(`${update.symbol}|${updateSession}`, { at: Date.now(), value: Promise.resolve(persistedSnapshot ?? stored) });
            persisted++;
          } catch (error) {
            log(`boot ${job.exchange} today backfill ${update.symbol} failed:`, String(error?.message || error).slice(0, 120));
          }
        }
        log(`boot ${job.exchange} today futures backfill: ${persisted}/${backfill?.attempted ?? 0} symbols persisted`);
      }
    }
  } catch (error) {
    log('futures warm pass failed:', String(error?.message || error));
  }
}

async function historyRefreshTodayBackfill(at) {
  if (!Number.isFinite(at) || isMarketSessionTime(at) || !isTradingDay(at)
    || typeof provider.backfillTodayFutures !== 'function') return 0;
  const session = getLatestTradingSessionDate(new Date(at));
  const expectedMinutes = Math.max(0, marketCloseMinuteFor(at) - (9 * 60 + 15) + 1);
  if (!expectedMinutes) return 0;
  const sparseSymbols = [];
  for (const underlying of universe.filter(item => !isMcxUnderlying(item))) {
    try {
      const stored = readFutures(SCAN_DIR, session, underlying.symbol);
      const nearMonth = stored?.months?.find(month => month.date >= session) ?? stored?.months?.[0];
      if (futureCaptureBelowCoverage(nearMonth?.candles, session, expectedMinutes, 0.6)) sparseSymbols.push(underlying.symbol);
    } catch (error) {
      log(`history refresh coverage ${underlying.symbol} failed: ${String(error?.message || error)}`);
    }
  }
  if (!sparseSymbols.length) return 0;

  const result = await provider.backfillTodayFutures(session, { symbols: sparseSymbols, force: true, postClose: true });
  let persisted = 0;
  for (const update of result?.updates ?? []) {
    let persistedSnapshot = null;
    await loadFuturesWithArchiveLock(
      archiveLock,
      () => Promise.resolve(update),
      snapshot => Promise.resolve().then(() => {
        persistedSnapshot = persistFutures(SCAN_DIR, session, update.symbol, snapshot, { preferIncomingCloseOi: false });
        return persistedSnapshot;
      }),
      error => log(`history refresh today-backfill ${update.symbol} persistence failed:`, error?.message || error),
    );
    if (!persistedSnapshot) continue;
    futuresCache.set(`${update.symbol}|${session}`, { at: Date.now(), value: Promise.resolve(persistedSnapshot) });
    persisted++;
  }
  if (result?.failed?.length) log(`history refresh today-backfill failed symbols: ${result.failed.join(' ')}`);
  return persisted;
}

const archive = createArchiveService({
  scanDir: SCAN_DIR,
  providerId: provider.id,
  archiveRoot: ARCHIVE_ROOT,
  logger: (...args) => log(...args),
  beforeArchive: async () => {
    archiveLock = 'settling';
    while (state.building || futuresActive > 0) await yieldToLoop();
    // Let a capture continuation after its previous futures call enter the
    // counter before sealing new work for the archive read/delete window.
    while (true) {
      await yieldToLoop();
      if (state.building || futuresActive > 0) continue;
      archiveLock = 'sealed';
      return () => { archiveLock = 'open'; };
    }
  },
});
let archivePass = null;

/** Archive only after the date-aware market session close; archive.mjs verifies before removal. */
async function closedRawDates(session, at) {
  let entries;
  try { entries = await fsp.readdir(SCAN_DIR, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry) && entry <= session)
    .filter(date => {
      const dateAt = Date.parse(`${date}T12:00:00+05:30`);
      return Number.isFinite(dateAt) && at > marketSessionBounds(dateAt).close;
    })
    .sort();
}

function queueClosedSessionArchives(session, at) {
  if (provider.alwaysLive || provider.id === 'demo') return;
  if (archivePass) return;
  archivePass = (async () => {
    // Re-scan after each settled pass: a capture finishing just after close
    // may create the raw futures directory after the first scan.
    while (true) {
      while (state.building || futuresActive > 0) await yieldToLoop();
      const dates = await closedRawDates(session, at);
      if (!dates.length) {
        await yieldToLoop();
        if (!state.building && futuresActive === 0 && !(await closedRawDates(session, at)).length) return;
        continue;
      }
      for (const date of dates) {
        // Idempotent: a date whose archive already exists (raw minutes cleaned,
        // dir left over) is done — retrying it forever just floods the log.
        if (fs.existsSync(path.join(ARCHIVE_ROOT, provider.id, `${date}.json.gz`))) continue;
        await archive.archive(date);
      }
      await yieldToLoop();
    }
  })().catch(error => log('archive pass failed:', error?.message || error)).finally(() => { archivePass = null; });
}

// ── HTTP ──────────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/** On every answer. The page loads nothing from elsewhere, so the policy allows only this origin. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': CORS_ORIGIN ? 'cross-origin' : 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...(CORS_ORIGIN ? { 'Access-Control-Allow-Origin': CORS_ORIGIN, Vary: 'Origin' } : {}),
};

function send(res, status, body, type = 'application/json', extra = {}) {
  let payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra };
  // JSON payloads reach megabytes (market ~2MB, observations ~220KB); gzip shrinks them ~10x,
  // which is the whole client-perceived load time on the tunnel.
  const accept = String(res.req?.headers?.['accept-encoding'] || '');
  if (accept.includes('gzip') && typeof payload === 'string' && payload.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = [headers.Vary, 'Accept-Encoding'].filter(Boolean).join(', ');
    payload = zlib.gzipSync(payload);
    headers['Content-Length'] = payload.length;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function sendArchiveReadError(res, error) {
  const code = error?.code || 'ARCHIVE_FAILED';
  const status = code === 'ARCHIVE_MISSING' ? 404 : 503;
  return send(res, status, { error: error?.message || 'Stored archive is unavailable.', code });
}

function liveArchiveRejection(date, at) {
  if (!Number.isFinite(at) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || date !== getLatestTradingSessionDate(new Date(at)) || !isTradingDay(at)) return null;
  const { open, close } = marketSessionBounds(at);
  const graceEnd = close + 30 * 60_000;
  if (at < open || at >= graceEnd || (!isMarketSessionTime(at) && at < close)) return null;
  const retryAt = new Date(graceEnd + 330 * 60_000);
  return {
    status: 409,
    body: {
      error: 'session-live',
      retryAfter: `${String(retryAt.getUTCHours()).padStart(2, '0')}:${String(retryAt.getUTCMinutes()).padStart(2, '0')} IST`,
    },
  };
}

export async function archiveRequestWithLiveGuard(method, requestUrl, archiveService, at, logger, request = archiveRequestAsync) {
  if (method === 'POST') {
    const date = String(requestUrl).match(/^\/api\/archive\/(\d{4}-\d{2}-\d{2})(?:\?|$)/)?.[1];
    if (date) {
      const rejection = liveArchiveRejection(date, at);
      if (rejection) return rejection;
    }
  }
  return request(method, requestUrl, archiveService, logger);
}

function serveFile(res, file, cache = 'no-cache') {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Basic auth, compared in constant time; on when MF_BASIC_AUTH is set. */
const authDigest = AUTH ? crypto.createHash('sha256').update(AUTH).digest() : null;
function authorised(req) {
  if (!authDigest) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = crypto.createHash('sha256').update(Buffer.from(header.slice(6), 'base64').toString('utf8')).digest();
  return crypto.timingSafeEqual(given, authDigest);
}

/** A path under `base`, or null when it would leave it. */
function inside(base, rel) {
  const full = path.normalize(path.join(base, rel));
  return full.startsWith(base + path.sep) || full === base ? full : null;
}

function validReplayDate(date) {
  if (!REPLAY_DATE.test(date)) return false;
  const midnight = Date.parse(`${date}T00:00:00+05:30`);
  return Number.isFinite(midnight) && marketParts(midnight).dateKey === date && isTradingDay(midnight);
}

function replayCursor(date, asOf) {
  if (!/^\d{4}$/.test(asOf)) return null;
  const hour = Number(asOf.slice(0, 2));
  const minute = Number(asOf.slice(2));
  const minuteOfDay = hour * 60 + minute;
  const close = marketCloseMinuteFor(Date.parse(`${date}T00:00:00+05:30`));
  if (hour > 23 || minute > 59 || minuteOfDay < 9 * 60 + 15 || minuteOfDay > close) return null;
  return Date.parse(`${date}T${asOf.slice(0, 2)}:${asOf.slice(2)}:00+05:30`);
}

function replayManifest(date) {
  let minutes;
  try {
    minutes = readReplayMinutes(SCAN_DIR, date, (session, minute, at) => marketParts(at).dateKey === session && hhmmOf(at) === minute);
  } catch (error) {
    if (error?.code === 'REPLAY_DATA_INVALID') return { invalid: true };
    throw error;
  }
  if (minutes == null) return null;
  const futures = {};
  const dir = path.join(SCAN_DIR, date, 'futures');
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const symbol = entry.slice(0, -5);
      if (!REPLAY_SYMBOL.test(symbol) || !bySymbol.has(symbol)) continue;
      try {
        const result = readFutures(SCAN_DIR, date, symbol);
        if (result) futures[symbol] = futuresCoverage(result);
      } catch (error) {
        if (error?.code !== 'REPLAY_DATA_INVALID') throw error;
        futures[symbol] = { available: false, months: [], firstAt: null, lastAt: null, start: null, end: null, invalid: true };
      }
    }
  }
  return {
    provider: { id: provider.id, label: provider.label },
    date,
    minutes,
    start: minutes[0]?.[1] ?? null,
    end: minutes.at(-1)?.[1] ?? null,
    futures,
  };
}

const server = http.createServer((req, res) => {
  // PERF PROBE: route timing for the Rust-porting evidence (never breaks serving).
  perfMark(req, res);
  // A bad request never takes the server down: anything thrown is answered, and logged here.
  handle(req, res).catch(error => {
    log('request failed:', req.method, String(req.url).slice(0, 200), error?.message || error);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    else res.destroy();
  });
});
// PERF PROBE: 60s JSONL report (event-loop lag + top routes by time) → server/data/perf-probe.jsonl
startPerfProbe({});
// Slow or idle clients are cut off rather than held open.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

async function handle(req, res) {
  if (!authorised(req)) return send(res, 401, { error: 'Sign in.' }, 'application/json', { 'WWW-Authenticate': 'Basic realm="Order Flow", charset="UTF-8"' });
  if (req.method === 'OPTIONS' && CORS_ORIGIN) return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'GET, HEAD, POST', 'Access-Control-Max-Age': '600' });
  const captureAction = captureRequest(req.method, req.url ?? '', capture, (...args) => log(...args));
  if (req.method !== 'GET' && req.method !== 'HEAD' && !captureAction) {
    const capturePath = /^\/api\/capture\/now(?:\?|$)/.test(req.url ?? '');
    const archivePath = /^\/api\/archive(?:\/|\?|$)/.test(req.url ?? '');
    return send(res, 405, { error: 'Method not allowed.' }, 'application/json', { Allow: capturePath || archivePath ? 'GET, HEAD, POST' : 'GET, HEAD' });
  }
  let url;
  let p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { error: 'Bad request.' });
  }
  if (p.includes('\0')) return send(res, 400, { error: 'Bad request.' });

  if (captureAction && p === '/api/capture/now') return send(res, captureAction.status, captureAction.body);

  const archiveAction = await archiveRequestWithLiveGuard(req.method, req.url ?? '', archive, now(), (...args) => log(...args));
  if (archiveAction) return send(res, archiveAction.status, archiveAction.body, 'application/json', archiveAction.headers || {});

  if (p === '/api/replay/days') {
    try { return send(res, 200, await listReplayDays(SCAN_DIR, ARCHIVE_ROOT, provider.id)); }
    catch (error) {
      log('replay days failed:', error?.message || error);
      return send(res, 503, { error: 'Stored replay catalog is invalid.', code: error?.code || 'REPLAY_DAYS_INVALID' });
    }
  }

  if (p === '/api/health') {
    return send(res, 200, healthPayload(provider, state, capture, now()));
  }

  if (p === '/api/status') {
    return send(res, 200, withCaptureStatus({
      provider: { id: provider.id, label: provider.label, alwaysLive: Boolean(provider.alwaysLive), usage: provider.getUsage?.() ?? null },
      ready: state.ready, clock: now(), session: getLatestTradingSessionDate(new Date(now())),
      market: state.latest ? { at: state.latest.t, date: state.latest.date, series: state.latest.series.length, nextExpiry: state.latest.series.filter(item => item?.next).length } : null,
      lastBuild: state.lastBuild && { at: state.lastBuild.at, series: state.lastBuild.series, failed: state.lastBuild.failed },
      lastError: state.lastError && { at: state.lastError.at, message: state.lastError.message }, universe: universe.length,
    }, capture));
  }

  if (p === '/api/market') {
    if (!state.latestJson) return send(res, 503, { error: state.lastError?.message ?? 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
    return send(res, 200, state.latestJson);
  }

  if (p === '/api/stream/spots') {
    // Server-sent events: the provider's in-memory feed readings (ticks the
    // sockets already received) pushed every 3s. Query params name the extra
    // contracts to track: symbols=A,B and options=SYM|strike|SIDE|expiry,…
    const streamSymbols = (url.searchParams.get('symbols') ?? '').split(',').filter(part => REPLAY_SYMBOL.test(part)).slice(0, 12);
    const streamOptions = (url.searchParams.get('options') ?? '').split(',').filter(Boolean).slice(0, 64).map(entry => {
      const [symbol, strike, side, expiry] = entry.split('|');
      return { symbol, strike: Number(strike), side: side === 'PE' ? 'PE' : 'CE', expiry };
    }).filter(option => option.symbol && Number.isFinite(option.strike));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const push = () => {
      try {
        // Pin the requested contracts so the feed keeps ticking them even when
        // the ±15 rebalance window drifts away from a card's strike.
        provider.trackOptions?.(streamOptions);
        const ticks = provider.ticksFor?.({ symbols: streamSymbols, options: streamOptions }) ?? { futures: {}, options: {} };
        res.write(`data: ${JSON.stringify({ t: now(), spots: provider.spots?.() ?? {}, futures: ticks.futures, optionTicks: ticks.options })}\n\n`);
      }
      catch (error) { console.warn('dhan: stream/spots tick push failed:', String(error?.message || error)); }
    };
    push();
    const timer = setInterval(push, 3000);
    req.on('close', () => clearInterval(timer));
    return;
  }

  const replayManifestPath = p.match(/^\/api\/replay\/([^/]+)\/manifest$/);
  if (replayManifestPath) {
    const date = replayManifestPath[1];
    if (!validReplayDate(date)) return send(res, 400, { error: 'Invalid replay session date.' });
    const manifest = replayManifest(date);
    if (manifest?.invalid) return send(res, 503, { error: 'Stored replay manifest is invalid.', code: 'REPLAY_MANIFEST_INVALID' });
    return manifest ? send(res, 200, manifest) : send(res, 404, { error: 'No replay session for that date.' });
  }

  const replayFuturesPath = p.match(/^\/api\/replay\/([^/]+)\/futures\/([^/]+)$/);
  if (replayFuturesPath) {
    const date = replayFuturesPath[1];
    const symbol = replayFuturesPath[2].toUpperCase();
    if (!validReplayDate(date)) return send(res, 400, { error: 'Invalid replay session date.' });
    if (!REPLAY_SYMBOL.test(symbol) || !bySymbol.has(symbol)) return send(res, 400, { error: 'Invalid replay underlying.' });
    const asOf = url.searchParams.get('asOf');
    const cursor = asOf && replayCursor(date, asOf);
    if (!cursor) return send(res, 400, { error: 'asOf must be a market-session time in HHMM.' });
    let result;
    try { result = readFutures(SCAN_DIR, date, symbol); }
    catch (error) {
      if (error instanceof ReplayDataError) return send(res, 503, { error: 'Stored replay futures are invalid.', code: 'REPLAY_FUTURES_INVALID' });
      throw error;
    }
    if (!result) return send(res, 404, { error: `No persisted futures for ${symbol} on ${date}.` });
    return send(res, 200, truncateFutures(result, cursor));
  }

  const strikesPath = p.match(/^\/api\/strikes\/([^/]+)$/);
  if (strikesPath) {
    const symbols = strikesPath[1].toUpperCase().split(',').filter(part => REPLAY_SYMBOL.test(part) && bySymbol.has(part)).slice(0, 4);
    if (!symbols.length) return send(res, 400, { error: 'Invalid underlying.' });
    const date = url.searchParams.get('date') ?? getLatestTradingSessionDate(new Date(now()));
    if (!validReplayDate(date)) return send(res, 400, { error: 'Invalid session date.' });
    const asOf = url.searchParams.get('asOf');
    const cursor = asOf ? replayCursor(date, asOf) : null;
    if (asOf && !cursor) return send(res, 400, { error: 'asOf must be a market-session time in HHMM.' });
    try {
      const payload = await strikeFlowFor(symbols, date, cursor);
      return payload ? send(res, 200, payload, 'application/json', { 'Cache-Control': 'public, max-age=60' }) : send(res, 404, { error: `No stored chain minutes for ${symbols.join('+')} on ${date}.` });
    }
    catch (error) { return sendArchiveReadError(res, error); }
  }

  if (p.startsWith('/api/replay/')) return send(res, 400, { error: 'Invalid replay request.' });

  const minute = p.match(/^\/api\/market\/(\d{4}-\d{2}-\d{2})\/(\d{4})$/);
  if (minute) {
    const day = path.join(SCAN_DIR, minute[1]);
    const file = path.join(day, `${minute[2]}.json`);
    try {
      const archivedMinute = await readArchiveMinuteFallback(SCAN_DIR, archive, minute[1], minute[2]);
      if (archivedMinute !== null) return send(res, 200, archivedMinute, 'application/json', { 'Cache-Control': 'public, max-age=86400' });
    }
    catch (error) { return sendArchiveReadError(res, error); }
    return fs.existsSync(file) ? serveFile(res, file, 'public, max-age=86400') : send(res, 404, { error: 'No such minute.' });
  }

  const futures = p.match(/^\/api\/futures\/([A-Za-z0-9&._-]{1,40})$/);
  if (futures) {
    const symbol = futures[1].toUpperCase();
    // Only the current session: the page never asks for another, and no visitor can spend the provider's quota on history.
    const current = getLatestTradingSessionDate(new Date(now()));
    const session = url.searchParams.get('session') ?? current;
    if (!bySymbol.has(symbol)) return send(res, 404, { error: 'Unknown underlying.' });
    try {
      const archivedFutures = await readArchiveFuturesFallback(SCAN_DIR, archive, session, symbol);
      if (archivedFutures !== null) return send(res, 200, archivedFutures);
    } catch (error) {
      if (error?.code === 'ARCHIVE_MISSING' && session === current) {
        // Preserve the normal current-session provider path when no raw/archive data exists yet.
      } else return sendArchiveReadError(res, error);
    }
    if (session !== current) return send(res, 400, { error: `Only the current session (${current}) is served.` });
    try {
      return send(res, 200, await futuresFor(symbol, session));
    } catch (error) {
      log(`futures ${symbol} failed:`, error?.message || error);
      return send(res, 502, { error: 'The data provider did not answer for this underlying.' });
    }
  }

  if (p === '/underlyings.json') return serveFile(res, path.join(ROOT, 'public/underlyings.json'), 'public, max-age=3600');
  if (p === '/api/orb') {
    const at = now();
    const session = state.latest?.date ?? getLatestTradingSessionDate(new Date(at));
    const cached = orbState.last && orbState.last.session === session && Number.isFinite(orbState.last.at) && at - orbState.last.at < 60_000;
    let scan = cached ? orbState.last : null;
    if (!scan) {
      if (!state.latest) return send(res, 503, { error: 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
      scan = computeOrb(at, state.latest);
    }
    return send(res, 200, { at: scan.at, session: scan.session, leading: scan.leading, counts: scan.counts, rows: scan.rows });
  }

  if (p === '/api/participation') {
    if (!state.latest) return send(res, 503, { error: 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
    const limit = Math.max(0, Math.min(300, Number(url.searchParams.get('limit')) || 0));
    const result = participation(state.latest.series, { limit });
    return send(res, 200, { at: result.at, session: state.latest.date, totals: result.totals, rows: result.rows });
  }

  if (p === '/api/pcr') {
    if (!state.latest) return send(res, 503, { error: 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
    const ts = Number.isFinite(state.latest.at) ? state.latest.at : now();
    return send(res, 200, pcrSnapshot(state.latest.series, ts, (symbol, at) => pcrHistory.shiftFor(symbol, at)));
  }

  if (p === '/api/observations') return send(res, 200, { cards: loadObservations(path.join(DATA_DIR, 'observations.json')) });

  // The built page; any other path is the page itself (its router is in memory).
  if (fs.existsSync(DIST)) {
    const file = inside(DIST, p === '/' ? 'index.html' : p.slice(1));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return serveFile(res, path.join(DIST, 'index.html'));
  }
  send(res, 404, { error: 'Not found. Run `npm run build` to serve the page from here, or `npm run dev`.' });
}

// Start from the file on disk so a restart serves at once.
try {
  state.latestJson = fs.readFileSync(path.join(SCAN_DIR, 'latest.json'), 'utf8');
  state.latest = JSON.parse(state.latestJson);
} catch { /* first run */ }

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
server.listen(PORT, HOST, async () => {
  log(`Order Flow on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT} · provider: ${provider.label} (${provider.id}) · ${universe.length} underlyings${AUTH ? ' · password on' : ''}`);
  if (!LOOPBACK.includes(HOST) && !AUTH) log('WARNING: listening beyond this machine with no password. Set MF_BASIC_AUTH=user:password, or put the server behind a proxy that signs people in.');
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      let telegramTaskActive = false;
      const subscriberPoll = async () => {
        if (telegramTaskActive) return;
        telegramTaskActive = true;
        try {
          const pollNow = Date.now();
          await pollCommands({
            token,
            statePath: SUBSCRIBERS_PATH,
            now: pollNow,
            log,
            send: sendTelegram,
            ownerChatId: process.env.TELEGRAM_CHAT_ID,
            handleLive: (symbol, side) => {
              if (!bySymbol.has(symbol)) return liveErrorMessage(symbol, 'unknown or unsupported symbol.');
              const market = state.latest;
              if (!market?.series?.some(series => series?.s === symbol)) return liveErrorMessage(symbol, 'no captured snapshot is available yet.');
              let spotReading = null;
              let futureReading = null;
              try { spotReading = provider.spots?.()?.[symbol] ?? null; } catch { /* use the captured market spot */ }
              try { futureReading = provider.ticksFor?.({ symbols: [symbol] })?.futures?.[symbol] ?? null; } catch { /* report unavailable cache */ }
              return liveSnapshotMessage({ symbol, side, market, spotReading, futureReading });
            },
            handleJournal: () => formatJournalMessage(
              loadObservations(path.join(DATA_DIR, 'observations.json')),
              marketParts(Date.now()).dateKey,
            ),
            handleObs: symbol => obsSnapshotMessage({
              symbol,
              observations: loadObservations(path.join(DATA_DIR, 'observations.json')),
            }),
            handleOi: (symbol, strike) => oiSnapshotMessage({ symbol, strike, market: state.latest }),
            isKnownSymbol: symbol => bySymbol.has(symbol),
          });
          const observations = loadObservations(path.join(DATA_DIR, 'observations.json'));
          const watchedSymbols = [...new Set(loadSubscribers(SUBSCRIBERS_PATH).subscribers
            .flatMap(subscriber => (subscriber.alerts ?? []))
            .filter(alert => alert.type === 'buildup')
            .map(alert => alert.symbol))];
          await flushScheduledDigests({
            digestState: alertDigestState,
            now: pollNow,
            broadcastChatIds: activeChatIds(loadSubscribers(SUBSCRIBERS_PATH)),
            observations,
            watchedSymbols,
            planMarket: state.latest,
            ownerChatId: process.env.TELEGRAM_CHAT_ID ?? null,
            send: sendTelegram,
            log,
          });
          const weeklyDate = weeklyReviewDue(pollNow, alertDigestState.weeklyReviewSentDay ?? null);
          if (weeklyDate) {
            alertDigestState.weeklyReviewSentDay = weeklyDate;
            const weeklyMessage = weeklyReviewMessage(observations, pollNow);
            if (weeklyMessage) await sendOwnerAndSubscribers(weeklyMessage);
          }
        } catch (error) {
          log('telegram background task failed:', String(error?.message || error));
        } finally {
          telegramTaskActive = false;
        }
      };
      const timer = setInterval(() => { void subscriberPoll(); }, 5000);
      timer.unref();
    } catch (error) {
      log('telegram polling did not start:', String(error?.message || error));
    }
  }
  try {
    await provider.init?.();
    state.ready = true;
    let mcxTaskErrorLogged = false;
    const runMcxWatch = async () => {
      const pollAt = Date.now();
      const poll = await mcxWatchPoll(pollAt, {
        dataDir: DATA_DIR,
        sendLevels: sendOwnerAndSubscribers,
        log,
        // LIVE TICKS FIRST (C4): the 6 MCX futures ride the provider WS —
        // read the built session series instead of burning REST quote quota.
        quoteSource: () => {
          const series = state.latestJson?.series ?? [];
          const live = {};
          for (const item of series) {
            if (item?.exchange !== 'MCX' || !item?.s) continue;
            const rows = Array.isArray(item.r) ? item.r : [];
            const last = rows.at(-1);
            live[String(item.securityId ?? '')] = {
              lastPrice: Number(item.sp),
              previousClose: Number(item.pc),
              oi: Number.isFinite(last?.[4]) ? last[4] : undefined,
              high: undefined,
              low: undefined,
            };
          }
          return live;
        },
      });
      await mcxEveningBrief(pollAt, {
        dataDir: DATA_DIR,
        quotes: poll?.quotes ?? {},
        sendOwner: sendTelegram,
        log,
      });
    };
    const safeMcxWatch = () => {
      void runMcxWatch().catch(error => {
        if (mcxTaskErrorLogged) return;
        mcxTaskErrorLogged = true;
        log('mcx: background poll stopped after unexpected error:', String(error?.message || error));
      });
    };
    safeMcxWatch();
    const mcxWatchTimer = setInterval(safeMcxWatch, 60_000);
    mcxWatchTimer.unref?.();
  } catch (error) {
    state.lastError = { at: Date.now(), message: `Provider failed to start: ${error?.message || error}` };
    log(state.lastError.message);
    return;
  }
  void futuresWarmPass();
  await build();
  schedule();
  capture.start();
});
