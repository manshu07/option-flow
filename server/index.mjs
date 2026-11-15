/**
 * Order Flow's server: the page's only data source, and its host.
 *
 *   GET /api/status                  which provider, its clock, what the last build did
 *   GET /api/market                  the market file: every underlying's nearest-expiry chain
 *   GET /api/market/<date>/<HHMM>    an earlier minute of today (the 15m / 1h windows)
 *   GET /api/futures/<SYMBOL>?session=YYYY-MM-DD   its futures months and 1-minute candles
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
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSeries, marketFile } from './marketFile.mjs';
import { createProvider } from './providers/index.mjs';
import { futuresCoverage, persistFutures, readFutures, readReplayMinutes, ReplayDataError, REPLAY_DATE, REPLAY_SYMBOL, truncateFutures } from './replayStorage.mjs';
import { captureRequest, createCapture, withCaptureStatus } from './capture.mjs';
import { archiveRequestAsync, createArchiveService, listReplayDays, readArchiveFuturesFallback, readArchiveMinuteFallback } from './archive.mjs';
import { filterLiveExpiries, getLatestTradingSessionDate, isMarketSessionTime, isTradingDay, marketCloseMinuteFor, marketParts, marketSessionBounds } from '../src/lib/marketSession.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const AUTH = process.env.MF_BASIC_AUTH || '';
const CORS_ORIGIN = process.env.MF_CORS_ORIGIN || '';
if (AUTH && !/^[^:]+:.{8,}$/.test(AUTH)) throw new Error('MF_BASIC_AUTH must be user:password, with a password of at least 8 characters.');
const DATA_DIR = path.resolve(ROOT, process.env.MF_DATA_DIR || 'server/data');
const DIST = path.join(ROOT, 'dist');
const WORKERS = 8;
/** A futures read is kept this long: the page asks again every two minutes. */
const FUTURES_KEEP_MS = 60_000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/underlyings.json'), 'utf8')).underlyings
  .filter(u => u && typeof u.symbol === 'string' && u.lot > 0);
const bySymbol = new Map(universe.map(u => [u.symbol, u]));
// `--recorded` (npm run dev:recorded / start:recorded) and `--archive` (npm run dev:archive) are shortcuts for MF_PROVIDER.
const flagged = ['recorded', 'archive'].find(id => process.argv.includes(`--${id}`));
const provider = createProvider(universe, flagged);
const now = () => (provider.now ? provider.now() : Date.now());
const SCAN_DIR = path.join(DATA_DIR, provider.id);
const ARCHIVE_ROOT = path.join(DATA_DIR, 'archives');
const BOOTED_AT = Date.now();

// ── Collector ─────────────────────────────────────────────────────────────

/** Expiries are read once a session: they change only when a contract lists or expires. */
const ladderCache = { session: '', bySymbol: new Map() };
const state = { ready: false, building: false, latestJson: null, latest: null, lastBuild: null, lastError: null };

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

async function build() {
  if (state.building) return;
  state.building = true;
  const started = Date.now();
  const clock = now();
  const session = getLatestTradingSessionDate(new Date(clock));
  // Post-close fast path: the market is shut and nothing is moving — serve the
  // session's last built snapshot (the real closing state, written by every
  // successful build) instead of crawling 215 chains through the paced REST
  // fallback. A fresh session day starts empty and builds live.
  if (!provider.alwaysLive && !isMarketSessionTime(clock)) {
    const stored = storedSessionSnapshot(SCAN_DIR, session);
    if (stored) {
      state.latest = stored.file;
      state.latestJson = stored.json;
      state.lastBuild = { at: stored.at, ms: Date.now() - started, series: stored.count, failed: 0, failedSymbols: [], firstError: null };
      state.lastError = null;
      log(`market file: ${stored.count} series (stored session snapshot — market closed), 0 failed, ${Date.now() - started} ms`);
      state.building = false;
      return;
    }
  }
  if (ladderCache.session !== session) { ladderCache.session = session; ladderCache.bySymbol.clear(); }
  const series = [];
  const ladders = {};
  const failed = [];
  let firstError = null;
  let cursor = 0;
  const worker = async () => {
    while (cursor < universe.length) {
      const u = universe[cursor++];
      try {
        let ladder = ladderCache.bySymbol.get(u.symbol);
        if (!ladder) {
          ladder = await provider.expiries(u);
          if (ladder.length) ladderCache.bySymbol.set(u.symbol, ladder);
        }
        const live = filterLiveExpiries(ladder, clock);
        ladders[u.symbol] = live;
        if (!live[0]) continue;
        const chain = await provider.optionChain(u, live[0]);
        const encoded = encodeSeries(u, { ...chain, expiry: chain.expiry || live[0] }, now());
        if (encoded) series.push(encoded); else failed.push(u.symbol);
      } catch (error) {
        failed.push(u.symbol);
        firstError ??= String(error?.message || error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (!series.length) throw new Error(firstError ? `No underlying answered: ${firstError}` : 'No underlying answered.');
    const at = now();
    const sorted = series.sort((a, b) => a.s.localeCompare(b.s));
    // Only a reading taken in session is a minute the windows can measure from.
    const minutes = isMarketSessionTime(at)
      ? storeMinute(session, at, JSON.stringify(marketFile({ at, date: session, series: sorted, minutes: [], ladders })))
      : readMinutes(session);
    const file = marketFile({ at, date: session, series: sorted, minutes, ladders });
    state.latest = file;
    state.latestJson = JSON.stringify(file);
    fs.mkdirSync(SCAN_DIR, { recursive: true });
    fs.writeFileSync(path.join(SCAN_DIR, 'latest.json'), state.latestJson);
    queueClosedSessionArchives(session, at);
    state.lastBuild = { at, ms: Date.now() - started, series: series.length, failed: failed.length, failedSymbols: failed.slice(0, 20), firstError };
    state.lastError = null;
    log(`market file: ${series.length} series, ${failed.length} failed, ${Date.now() - started} ms${firstError ? ` (first error: ${firstError})` : ''}`);
  } catch (error) {
    // The detail (which may quote the provider's own error) stays in this log; the page gets a plain line.
    log('market file failed:', String(error?.message || error));
    state.lastError = { at: Date.now(), message: 'The data provider did not answer. The server log has the detail.' };
  } finally {
    state.building = false;
  }
}

/** Live (in session, or a provider that is always live): every minute, a few seconds past the boundary. Otherwise hourly. */
function schedule() {
  const live = provider.alwaysLive || isMarketSessionTime(Date.now());
  const wait = live ? 60_000 - (Date.now() % 60_000) + 3_000 : 60 * 60_000;
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
  let feed = { healthy: true, packets: null, lastPacketAt: null, connections: null };
  let tokenState = 'ok';
  try {
    const health = typeof provider?.health === 'function' ? provider.health() : null;
    if (health) {
      feed = {
        healthy: Boolean(health.healthy),
        packets: Number.isFinite(health.packets) ? health.packets : null,
        lastPacketAt: Number.isFinite(health.lastPacketAt) ? health.lastPacketAt : null,
        connections: health.connections ?? null,
      };
      if (health.flowing !== undefined) feed.flowing = Boolean(health.flowing);
      tokenState = health.tokenState === 'rejected' ? 'rejected' : 'ok';
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
        held.series.push([file.t, ltp, Number.isFinite(oi) ? oi : null, Number.isFinite(volume) ? volume : null]);
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
        ltp: last?.[1] ?? null, oi: last?.[2] ?? null, volume: last?.[3] ?? null,
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
        spotDistancePct: lastSpot ? ((item.strike - lastSpot) / lastSpot) * 100 : null }];
    })),
  };
}

const strikeFlowCache = new Map();
const STRIKE_FLOW_CACHE_LIMIT = 20;

/**
 * One or more underlyings' strike flow for a session: minutes come from the
 * live dir, falling back to one archive read for closed sessions. Full-day
 * aggregates are cached (invalidated when the minute count moves); `cursor`
 * (epoch ms) truncates to an as-of instant without re-reading anything.
 */
async function strikeFlowFor(symbols, date, cursor = null) {
  const cacheKey = `${date}|${symbols.join('+')}`;
  const minutes = readMinutes(date);
  let payload = strikeFlowCache.get(cacheKey);
  if (!payload || payload.minuteCount !== minutes.length) {
    const files = [];
    if (minutes.length) {
      for (const [hhmm] of minutes) {
        try { files.push(JSON.parse(fs.readFileSync(path.join(SCAN_DIR, date, `${hhmm}.json`), 'utf8'))); }
        catch { /* a corrupt or vanished minute is skipped, not fatal */ }
      }
    } else {
      // Closed and archived: the raw day dir is pruned, so the whole session
      // comes from one archive read — never one read per minute.
      try {
        const session = await archive.readSession(date);
        for (const [hhmm] of session.minutesIndex) {
          const json = session.minutes[hhmm];
          if (json == null) continue;
          try { files.push(typeof json === 'string' ? JSON.parse(json) : json); }
          catch { /* a corrupt minute is skipped, not fatal */ }
        }
      } catch (error) {
        if (error?.code !== 'ARCHIVE_MISSING') throw error;
      }
    }
    if (!files.length) return null;
    payload = strikeFlowFromFiles(files, symbols);
    payload.date = date;
    payload.minuteCount = files.length;
    strikeFlowCache.set(cacheKey, payload);
    if (strikeFlowCache.size > STRIKE_FLOW_CACHE_LIMIT) strikeFlowCache.delete(strikeFlowCache.keys().next().value);
  }
  return cursor ? truncateStrikeFlow(payload, cursor) : payload;
}

async function futuresFor(symbol, session) {
  const key = `${symbol}|${session}`;
  const held = futuresCache.get(key);
  const live = provider.alwaysLive || isMarketSessionTime(Date.now());
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
    const session = getLatestTradingSessionDate(new Date(now()));
    let warmed = 0;
    for (const u of universe) {
      try { await futuresFor(u.symbol, session); warmed += 1; }
      catch (error) { log(`warm pass ${u.symbol} failed:`, String(error?.message || error).slice(0, 120)); }
    }
    log(`futures warm pass: ${warmed}/${universe.length} symbols cached`);
  } catch (error) {
    log('futures warm pass failed:', String(error?.message || error));
  }
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
      for (const date of dates) await archive.archive(date);
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
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendArchiveReadError(res, error) {
  const code = error?.code || 'ARCHIVE_FAILED';
  const status = code === 'ARCHIVE_MISSING' ? 404 : 503;
  return send(res, status, { error: error?.message || 'Stored archive is unavailable.', code });
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
  // A bad request never takes the server down: anything thrown is answered, and logged here.
  handle(req, res).catch(error => {
    log('request failed:', req.method, String(req.url).slice(0, 200), error?.message || error);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    else res.destroy();
  });
});
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

  const archiveAction = await archiveRequestAsync(req.method, req.url ?? '', archive, (...args) => log(...args));
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
      provider: { id: provider.id, label: provider.label, alwaysLive: Boolean(provider.alwaysLive) },
      ready: state.ready, clock: now(), session: getLatestTradingSessionDate(new Date(now())),
      market: state.latest ? { at: state.latest.t, date: state.latest.date, series: state.latest.series.length } : null,
      lastBuild: state.lastBuild && { at: state.lastBuild.at, series: state.lastBuild.series, failed: state.lastBuild.failed },
      lastError: state.lastError && { at: state.lastError.at, message: state.lastError.message }, universe: universe.length,
    }, capture));
  }

  if (p === '/api/market') {
    if (!state.latestJson) return send(res, 503, { error: state.lastError?.message ?? 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
    return send(res, 200, state.latestJson);
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
  try {
    await provider.init?.();
    state.ready = true;
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
