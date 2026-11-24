import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay, marketParts } from '../src/lib/marketSession.ts';
import { sendTelegram } from './telegram.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.dhan.co/v2/marketfeed/quote';
export const MCX_SYMBOLS = ['GOLD', 'SILVER', 'NATURALGAS', 'GOLDM', 'SILVERM', 'NATURALGASM'];
export const DEFAULT_MCX_SECURITY_IDS = Object.freeze({
  GOLD: 495213,
  SILVER: 495214,
  NATURALGAS: 574319,
  GOLDM: 575011,
  SILVERM: 483080,
  NATURALGASM: 574320,
});

const OPEN_MINUTE = 9 * 60;
const BRIEF_MINUTE = 21 * 60;
const warningHours = new Map();

function nowMs(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function dataPath(dataDir, filename) {
  return path.join(dataDir ?? process.env.MF_DATA_DIR ?? path.join(ROOT, 'server', 'data'), filename);
}

function dayKeyAt(now) {
  const parts = marketParts(now);
  return parts.dateKey;
}

function clockAt(now) {
  const parts = marketParts(now);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function logOncePerHour(kind, message, now, log) {
  const parts = marketParts(now);
  const key = `${kind}:${parts.dateKey}:${String(parts.hour).padStart(2, '0')}`;
  if (warningHours.has(key)) return;
  warningHours.set(key, true);
  if (warningHours.size > 200) warningHours.clear();
  log(message);
}

function readIds(now, log, raw = process.env.MCX_SECURITY_IDS) {
  if (!raw) return DEFAULT_MCX_SECURITY_IDS;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || MCX_SYMBOLS.some(symbol => !Number.isSafeInteger(Number(parsed[symbol])) || Number(parsed[symbol]) <= 0)) {
      throw new Error('MCX_SECURITY_IDS must be a JSON object containing positive integer IDs for all six symbols');
    }
    return Object.fromEntries(MCX_SYMBOLS.map(symbol => [symbol, Number(parsed[symbol])]));
  } catch (error) {
    logOncePerHour('security-ids', `mcx: invalid MCX_SECURITY_IDS; poll skipped (${error?.message || error})`, now, log);
    return null;
  }
}

function closeMinute(now, log, raw = process.env.MCX_CLOSE_MINUTE) {
  if (raw == null || raw === '') return 23 * 60 + 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= OPEN_MINUTE || value > 23 * 60 + 59) {
    logOncePerHour('close-minute', 'mcx: invalid MCX_CLOSE_MINUTE; poll skipped', now, log);
    return null;
  }
  return value;
}

export function mcxSessionOpen(now, { log = () => {}, closeMinuteEnv = process.env.MCX_CLOSE_MINUTE } = {}) {
  const at = nowMs(now);
  const parts = marketParts(at);
  const close = closeMinute(at, log, closeMinuteEnv);
  return close != null && isTradingDay(at) && parts.minuteOfDay >= OPEN_MINUTE && parts.minuteOfDay <= close;
}

function freshState(dayKey) {
  return { dayKey, sentBrief: false, fired: {}, warnings: {} };
}

function loadState(statePath, dayKey, log, now) {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    if (saved?.dayKey === dayKey) {
      return {
        dayKey,
        sentBrief: saved.sentBrief === true,
        fired: saved.fired && typeof saved.fired === 'object' && !Array.isArray(saved.fired) ? saved.fired : {},
        warnings: saved.warnings && typeof saved.warnings === 'object' && !Array.isArray(saved.warnings) ? saved.warnings : {},
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') logOncePerHour('state-file', `mcx: state file unreadable; starting a fresh daily latch (${error?.message || error})`, now, log);
  }
  return freshState(dayKey);
}

function saveState(statePath, state, log, now) {
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    return true;
  } catch (error) {
    logOncePerHour('state-write', `mcx: state persistence failed; alert skipped (${error?.message || error})`, now, log);
    return false;
  }
}

function parseQuotePayload(body) {
  const data = body?.data ?? body;
  const segment = data?.MCX_COMM ?? data?.data?.MCX_COMM;
  if (!segment || typeof segment !== 'object') return [];
  return segment;
}

function normalizeQuote(raw) {
  const ltp = Number(raw?.last_price);
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const previousClose = Number(raw?.ohlc?.close);
  const high = Number(raw?.ohlc?.high);
  const low = Number(raw?.ohlc?.low);
  const oiValue = raw?.oi ?? raw?.open_interest ?? raw?.openInterest;
  const oi = Number(oiValue);
  return {
    lastPrice: ltp,
    previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    percentChange: Number.isFinite(previousClose) && previousClose > 0 ? ((ltp - previousClose) / previousClose) * 100 : null,
    oi: oiValue != null && Number.isFinite(oi) && oi >= 0 ? oi : null,
    high: Number.isFinite(high) && high > 0 ? high : null,
    low: Number.isFinite(low) && low > 0 ? low : null,
  };
}

function displayNumber(value, digits = 2) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(value) : '—';
}

function loadLevels(levelsPath, state, statePath, log, now) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(levelsPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      if (!state.warnings.levelsMissing) {
        state.warnings.levelsMissing = true;
        if (saveState(statePath, state, log, now)) log(`mcx: levels file missing; M2 idle for ${state.dayKey}`);
      }
      return [];
    }
    logOncePerHour('levels-file', `mcx: levels file unreadable; M2 skipped (${error?.message || error})`, now, log);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logOncePerHour('levels-shape', 'mcx: levels file must be a JSON array; M2 skipped', now, log);
    return [];
  }
  const valid = [];
  const seen = new Set();
  let stateChanged = false;
  const newWarnings = [];
  for (const [index, item] of parsed.entries()) {
    const rawLabel = typeof item?.label === 'string' ? item.label : '';
    const label = rawLabel.trim();
    const key = `${item?.symbol}|${label}`;
    const malformed = !MCX_SYMBOLS.includes(item?.symbol) || !label || label.length > 80
      || /[\u0000-\u001f\u007f]/.test(rawLabel) || !Number.isFinite(item?.price)
      || item.price <= 0 || !['up', 'down'].includes(item?.dir) || seen.has(key);
    if (malformed) {
      const warningKey = `level:${index}:${key}`;
      if (!state.warnings[warningKey]) {
        state.warnings[warningKey] = true;
        stateChanged = true;
        newWarnings.push(`mcx: malformed or duplicate level entry skipped at index ${index}`);
      }
      continue;
    }
    seen.add(key);
    valid.push({ symbol: item.symbol, label, price: item.price, dir: item.dir, key });
  }
  if (stateChanged && saveState(statePath, state, log, now)) {
    for (const warning of newWarnings) log(warning);
  }
  return valid;
}

async function fireCrossedLevels(quotes, now, { levelsPath, statePath, sendLevels, log }) {
  const state = loadState(statePath, dayKeyAt(now), log, now);
  const levels = loadLevels(levelsPath, state, statePath, log, now);
  const firedSymbols = new Set();
  const fired = [];
  for (const level of levels) {
    if (firedSymbols.has(level.symbol) || state.fired[level.key]) continue;
    const quote = quotes[level.symbol];
    if (!quote) continue;
    const crossed = level.dir === 'up' ? quote.lastPrice >= level.price : quote.lastPrice <= level.price;
    if (!crossed) continue;
    state.fired[level.key] = true;
    if (!saveState(statePath, state, log, now)) continue;
    firedSymbols.add(level.symbol);
    const message = `📊 MCX ${level.symbol} ${level.label} — price ${displayNumber(quote.lastPrice)} crossed ${displayNumber(level.price)} (${level.dir}) · ${clockAt(now)} IST`;
    fired.push({ symbol: level.symbol, label: level.label, message });
    if (typeof sendLevels !== 'function') continue;
    try {
      const result = await sendLevels(message);
      if (result?.sent === false) log(`mcx: level alert ${level.symbol}/${level.label} not sent (${result.reason ?? 'unknown'})`);
    } catch (error) {
      log(`mcx: level alert ${level.symbol}/${level.label} failed (${error?.message || error})`);
    }
  }
  return fired;
}

export async function mcxEveningBrief(now = Date.now(), {
  dataDir,
  statePath = dataPath(dataDir, 'mcx-brief-state.json'),
  quotes = {},
  sendOwner = sendTelegram,
  log = () => {},
  closeMinuteEnv = process.env.MCX_CLOSE_MINUTE,
} = {}) {
  const at = nowMs(now);
  if (!mcxSessionOpen(at, { log, closeMinuteEnv })) return { sent: false, skipped: 'outside MCX session' };
  const parts = marketParts(at);
  const state = loadState(statePath, parts.dateKey, log, at);
  if (state.sentBrief) return { sent: false, skipped: 'already sent' };
  if (parts.minuteOfDay < BRIEF_MINUTE) return { sent: false, skipped: 'not due' };
  if (parts.minuteOfDay >= BRIEF_MINUTE + 1) {
    state.sentBrief = true;
    saveState(statePath, state, log, at);
    return { sent: false, skipped: '21:00 window passed' };
  }

  state.sentBrief = true;
  if (!saveState(statePath, state, log, at)) return { sent: false, skipped: 'state persistence failed' };
  const lines = MCX_SYMBOLS.filter(symbol => quotes?.[symbol]).map(symbol => {
    const quote = quotes[symbol];
    const change = quote.percentChange == null ? '—' : `${quote.percentChange >= 0 ? '+' : ''}${quote.percentChange.toFixed(2)}%`;
    return `${symbol} ${displayNumber(quote.lastPrice, 0)} (prev ${displayNumber(quote.previousClose, 0)}, ${change}) · OI ${displayNumber(quote.oi, 0)} · H ${displayNumber(quote.high, 0)} L ${displayNumber(quote.low, 0)}`;
  });
  if (!lines.length) {
    logOncePerHour('brief-empty', `mcx: 21:00 brief skipped; no quote data for ${parts.dateKey}`, at, log);
    return { sent: false, skipped: 'no quote data' };
  }
  const message = `📊 MCX evening watchlist · ${parts.dateKey} ${clockAt(at)} IST\n${lines.join('\n')}`;
  try {
    const result = await sendOwner(message);
    log(`mcx: owner evening brief ${result?.sent ? 'sent' : `not sent (${result?.reason ?? 'unknown'})`}`);
    return { sent: result?.sent === true, message };
  } catch (error) {
    log(`mcx: owner evening brief failed (${error?.message || error})`);
    return { sent: false, reason: error?.message || String(error) };
  }
}

export async function mcxWatchPoll(now = Date.now(), {
  dataDir,
  levelsPath = dataPath(dataDir, 'mcx-levels.json'),
  statePath = dataPath(dataDir, 'mcx-brief-state.json'),
  fetchImpl = globalThis.fetch,
  accessToken = process.env.DHAN_ACCESS_TOKEN,
  clientId = process.env.DHAN_CLIENT_ID,
  log = () => {},
  securityIdsEnv = process.env.MCX_SECURITY_IDS,
  closeMinuteEnv = process.env.MCX_CLOSE_MINUTE,
  sendLevels,
} = {}) {
  const at = nowMs(now);
  if (!mcxSessionOpen(at, { log, closeMinuteEnv })) return { skipped: 'outside MCX session', quotes: {} };
  const ids = readIds(at, log, securityIdsEnv);
  if (!ids) return { skipped: 'invalid security ID config', quotes: {} };
  if (!accessToken || !clientId) {
    logOncePerHour('credentials', 'mcx: quote poll skipped; Dhan credentials are unavailable', at, log);
    return { skipped: 'missing credentials', quotes: {} };
  }
  let response;
  try {
    response = await fetchImpl(API, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'access-token': accessToken, 'client-id': clientId },
      body: JSON.stringify({ MCX_COMM: MCX_SYMBOLS.map(symbol => ids[symbol]) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    logOncePerHour('network', `mcx: quote poll failed; skipped (${error?.message || error})`, at, log);
    return { skipped: 'network error', quotes: {} };
  }
  if (response.status === 429) {
    logOncePerHour('429', 'mcx: Dhan quote poll rate-limited; skipped', at, log);
    return { skipped: 'rate limited', quotes: {} };
  }
  if ([401, 807].includes(response.status)) {
    logOncePerHour('expired-token', 'mcx: Dhan token expired/rejected; quote poll skipped', at, log);
    return { skipped: 'token rejected', quotes: {} };
  }
  if (!response.ok) {
    logOncePerHour(`http-${response.status}`, `mcx: quote poll HTTP ${response.status}; skipped`, at, log);
    return { skipped: `HTTP ${response.status}`, quotes: {} };
  }

  let body;
  try { body = await response.json(); }
  catch (error) {
    logOncePerHour('bad-json', `mcx: invalid quote response; skipped (${error?.message || error})`, at, log);
    return { skipped: 'invalid JSON', quotes: {} };
  }
  if (body?.status === 'failure') {
    const message = String(body?.remarks ?? body?.errorMessage ?? 'Dhan failure');
    const expired = /token|auth|credential/i.test(message);
    logOncePerHour(expired ? 'expired-token' : 'api-failure', `mcx: Dhan quote poll skipped (${expired ? 'token rejected' : 'API failure'})`, at, log);
    return { skipped: expired ? 'token rejected' : 'API failure', quotes: {} };
  }
  const rawById = parseQuotePayload(body);
  const quotes = {};
  for (const symbol of MCX_SYMBOLS) {
    const quote = normalizeQuote(rawById[String(ids[symbol])]);
    if (quote) quotes[symbol] = quote;
  }
  if (!Object.keys(quotes).length) {
    logOncePerHour('empty', 'mcx: Dhan quote response empty; poll skipped', at, log);
    return { skipped: 'empty response', quotes: {} };
  }
  const fired = await fireCrossedLevels(quotes, at, { levelsPath, statePath, sendLevels, log });
  return { polled: true, quotes, fired };
}
