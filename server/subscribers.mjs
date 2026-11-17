import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_SUBSCRIBERS = 500;
const HINT_LIMIT = 3;
const HINT_WINDOW_MS = 60 * 60_000;
const LIVE_LIMIT = 5;
const LIVE_WINDOW_MS = 10 * 60_000;
const MAX_PERSONAL_ALERTS = 10;
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hintTimes = new Map();
const liveTimes = new Map();

function normalizeAlerts(value) {
  const seen = new Set();
  const alerts = [];
  for (const row of Array.isArray(value) ? value : []) {
    const id = String(row?.id ?? '').trim().slice(0, 24);
    const symbol = String(row?.symbol ?? '').trim().toUpperCase();
    const type = row?.type === 'buildup' ? 'buildup' : null;
    if (type === 'buildup') {
      // A /watch subscription: symbol-level buildup rule, no level.
      if (!id || seen.has(id) || !/^[A-Z0-9&._-]{1,40}$/.test(symbol)) continue;
      seen.add(id);
      alerts.push({ id, symbol, type: 'buildup', createdAt: Number.isFinite(row?.createdAt) ? row.createdAt : 0 });
      if (alerts.length >= MAX_PERSONAL_ALERTS) break;
      continue;
    }
    const direction = row?.direction;
    const level = Number(row?.level);
    if (!id || seen.has(id) || !/^[A-Z0-9&._-]{1,40}$/.test(symbol)
      || (direction !== 'above' && direction !== 'below')
      || !Number.isFinite(level) || level <= 0) continue;
    seen.add(id);
    alerts.push({ id, symbol, direction, level, createdAt: Number.isFinite(row?.createdAt) ? row.createdAt : 0 });
    if (alerts.length >= MAX_PERSONAL_ALERTS) break;
  }
  return alerts;
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return { subscribers: [], offset: 0 };
  const byChatId = new Map();
  for (const row of Array.isArray(value.subscribers) ? value.subscribers : []) {
    const chatId = Number(row?.chatId);
    if (!Number.isSafeInteger(chatId) || chatId === 0) continue;
    byChatId.set(chatId, {
      chatId,
      startedAt: Number.isFinite(row?.startedAt) ? row.startedAt : 0,
      active: row?.active === true,
      alerts: normalizeAlerts(row?.alerts),
    });
  }
  return {
    subscribers: [...byChatId.values()],
    offset: Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0,
  };
}

export function loadSubscribers(path) {
  try { return normalizeState(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return { subscribers: [], offset: 0 }; }
}

export function saveSubscribers(path, state) {
  const normalized = normalizeState(state);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(normalized, null, 2));
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing was staged */ }
    throw error;
  }
}

export function activeChatIds(state) {
  return normalizeState(state).subscribers.filter(row => row.active).map(row => row.chatId);
}

function commandFor(text) {
  const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
  return match ? { name: match[1].toLowerCase(), args: String(match[2] ?? '').trim() } : null;
}

function maySendHint(chatId, now) {
  const key = String(chatId);
  const recent = (hintTimes.get(key) ?? []).filter(at => now - at < HINT_WINDOW_MS);
  if (recent.length >= HINT_LIMIT) {
    hintTimes.set(key, recent);
    return false;
  }
  recent.push(now);
  hintTimes.set(key, recent);
  return true;
}

function mayRequestLive(chatId, now) {
  const key = String(chatId);
  const recent = (liveTimes.get(key) ?? []).filter(at => now - at < LIVE_WINDOW_MS);
  if (recent.length >= LIVE_LIMIT) {
    liveTimes.set(key, recent);
    return false;
  }
  recent.push(now);
  liveTimes.set(key, recent);
  return true;
}

function processCommand(state, message, now, replies, ownerChatId, isKnownSymbol) {
  const chatId = Number(message?.chat?.id);
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  const parsed = commandFor(message?.text);
  const command = parsed?.name;
  const subscriber = state.subscribers.find(row => row.chatId === chatId);

  if (command === 'start') {
    if (subscriber?.active) {
      replies.push({ chatId, text: 'Already subscribed. Use /stop to unsubscribe.' });
      return;
    }
    const activeCount = state.subscribers.filter(row => row.active).length;
    if (activeCount >= MAX_SUBSCRIBERS) {
      replies.push({ chatId, text: 'The subscriber list is full. Please try again later.' });
      return;
    }
    if (subscriber) {
      subscriber.startedAt = now;
      subscriber.active = true;
    } else {
      state.subscribers.push({ chatId, startedAt: now, active: true });
    }
    replies.push({ chatId, text: 'Subscribed to free daily market-data digests (OI spikes, top movers, index levels). Educational only; not investment advice. Use /stop to opt out.' });
    return;
  }

  if (command === 'stop') {
    if (!subscriber?.active) {
      replies.push({ chatId, text: 'You are not subscribed. Use /start to subscribe.' });
      return;
    }
    subscriber.active = false;
    replies.push({ chatId, text: 'Subscription stopped. Use /start to rejoin later.' });
    return;
  }

  if (command === 'help') {
    replies.push({ chatId, text: '/start subscribe · /stop unsubscribe · /live SYMBOL [CE|PE] · /obs SYMBOL · /oi SYMBOL [STRIKE] · /watch SYMBOL · /unwatch SYMBOL · /journal · /alert SYMBOL above|below LEVEL · /alerts · /help show commands\nFree educational market-data digests only; not investment advice.' });
    return;
  }

  if (command === 'live') {
    const args = parsed.args.split(/\s+/).filter(Boolean);
    const symbol = args[0]?.toUpperCase();
    const side = args[1]?.toUpperCase() ?? null;
    const authorized = subscriber?.active || String(chatId) === String(ownerChatId ?? '');
    if (!authorized) {
      replies.push({ chatId, text: 'Use /start to subscribe before using /live. Educational data only; not investment advice.' });
      return;
    }
    if (!symbol || args.length > 2 || (side != null && side !== 'CE' && side !== 'PE')) {
      replies.push({ chatId, text: 'Usage: /live SYMBOL [CE|PE]. Educational data only; not investment advice.' });
      return;
    }
    if (!mayRequestLive(chatId, now)) {
      replies.push({ chatId, text: '/live is limited to 5 requests per 10 minutes. Educational data only; not investment advice.' });
      return;
    }
    replies.push({ chatId, live: { symbol, side }, parseMode: 'HTML' });
    return;
  }

  if (command === 'obs' || command === 'oi') {
    const authorized = subscriber?.active || String(chatId) === String(ownerChatId ?? '');
    if (!authorized) {
      replies.push({ chatId, text: `Use /start to subscribe before using /${command}. Educational data only; not investment advice.` });
      return;
    }
    const args = parsed.args.split(/\s+/).filter(Boolean);
    const symbol = args[0]?.toUpperCase();
    if (!symbol || args.length > 2 || !/^[A-Z0-9&._-]{1,40}$/.test(symbol)) {
      replies.push({ chatId, text: command === 'obs'
        ? 'Usage: /obs SYMBOL. Educational data only; not investment advice.'
        : 'Usage: /oi SYMBOL [STRIKE]. Educational data only; not investment advice.' });
      return;
    }
    if (!maySendHint(chatId, now)) {
      replies.push({ chatId, text: `Requests are limited to ${HINT_LIMIT} per hour. Educational data only; not investment advice.` });
      return;
    }
    if (command === 'obs') {
      replies.push({ chatId, obs: { symbol }, parseMode: 'HTML' });
    } else {
      const strike = args[1] != null ? Number(args[1]) : null;
      if (args[1] != null && (!Number.isFinite(strike) || strike <= 0)) {
        replies.push({ chatId, text: 'Usage: /oi SYMBOL [STRIKE]. Educational data only; not investment advice.' });
        return;
      }
      replies.push({ chatId, oi: { symbol, strike }, parseMode: 'HTML' });
    }
    return;
  }

  if (command === 'watch' || command === 'unwatch') {
    const authorized = subscriber?.active || String(chatId) === String(ownerChatId ?? '');
    if (!authorized) {
      replies.push({ chatId, text: `Use /start to subscribe before using /${command}. Educational data only; not investment advice.` });
      return;
    }
    const symbol = parsed.args.split(/\s+/).filter(Boolean)[0]?.toUpperCase();
    if (command === 'watch' && !symbol) {
      const watched = (subscriber?.alerts ?? []).filter(alert => alert.type === 'buildup');
      replies.push({ chatId, text: watched.length
        ? `Watching: ${watched.map(alert => escapeHtml(alert.symbol)).join(', ')}\n\n🎓 Educational data only; not investment advice.`
        : 'Not watching any symbol. Use /watch SYMBOL to add one.\n\n🎓 Educational data only; not investment advice.', parseMode: 'HTML' });
      return;
    }
    if (!symbol || !/^[A-Z0-9&._-]{1,40}$/.test(symbol) || parsed.args.split(/\s+/).filter(Boolean).length > 1) {
      replies.push({ chatId, text: `Usage: /${command} SYMBOL. Educational data only; not investment advice.` });
      return;
    }
    if (command === 'watch') {
      if (typeof isKnownSymbol === 'function' && !isKnownSymbol(symbol)) {
        replies.push({ chatId, text: `${escapeHtml(symbol)} is unknown or unsupported. Educational data only; not investment advice.`, parseMode: 'HTML' });
        return;
      }
      if ((subscriber?.alerts ?? []).some(alert => alert.type === 'buildup' && alert.symbol === symbol)) {
        replies.push({ chatId, text: `Already watching ${escapeHtml(symbol)}. Educational data only; not investment advice.` });
        return;
      }
      if ((subscriber?.alerts ?? []).length >= MAX_PERSONAL_ALERTS) {
        replies.push({ chatId, text: `Watch/alert limit reached (${MAX_PERSONAL_ALERTS}). Use /unwatch or /unalert first. Educational data only; not investment advice.` });
        return;
      }
      let id;
      do { id = randomBytes(4).toString('hex'); }
      while (subscriber.alerts.some(alert => alert.id === id));
      subscriber.alerts.push({ id, symbol, type: 'buildup', createdAt: now });
      replies.push({ chatId, text: `Now watching <b>${escapeHtml(symbol)}</b>: its build-ups join your alerts and its observations join the EOD report. Educational data only; not investment advice.`, parseMode: 'HTML' });
      return;
    }
    const before = (subscriber?.alerts ?? []).length;
    if (!subscriber) { replies.push({ chatId, text: `You were not watching ${escapeHtml(symbol)}. Educational data only; not investment advice.` }); return; }
    subscriber.alerts = subscriber.alerts.filter(alert => !(alert.type === 'buildup' && alert.symbol === symbol));
    replies.push({ chatId, text: subscriber.alerts.length < before
      ? `Stopped watching ${escapeHtml(symbol)}. Educational data only; not investment advice.`
      : `You were not watching ${escapeHtml(symbol)}. Educational data only; not investment advice.`, parseMode: 'HTML' });
    return;
  }

  if (command === 'journal') {
    const authorized = subscriber?.active || String(chatId) === String(ownerChatId ?? '');
    if (!authorized) {
      replies.push({ chatId, text: 'Use /start to subscribe before using /journal. Educational data only; not investment advice.' });
      return;
    }
    replies.push({ chatId, journal: true, parseMode: 'HTML' });
    return;
  }

  if (command === 'alert' || command === 'alerts' || command === 'unalert') {
    if (!subscriber?.active) {
      replies.push({ chatId, text: 'Use /start to subscribe before managing personal alerts. Educational data only; not investment advice.' });
      return;
    }
    if (command === 'alerts') {
      const lines = subscriber.alerts.length
        ? subscriber.alerts.map(alert => alert.type === 'buildup'
          ? `• <b>${escapeHtml(alert.id)}</b> watch ${escapeHtml(alert.symbol)} (build-up)`
          : `• <b>${escapeHtml(alert.id)}</b> ${escapeHtml(alert.symbol)} ${alert.direction} ${alert.level}`)
        : ['No personal alerts or watches set. Use /alert SYMBOL above|below LEVEL or /watch SYMBOL.'];
      replies.push({ chatId, text: `${lines.join('\n')}\n\n🎓 Personal alerts use captured educational data, not investment advice.`, parseMode: 'HTML' });
      return;
    }
    if (command === 'alert') {
      const args = parsed.args.split(/\s+/).filter(Boolean);
      const symbol = args[0]?.toUpperCase();
      const direction = args[1]?.toLowerCase();
      const level = Number(args[2]);
      const validSyntax = args.length === 3 && /^[A-Z0-9&._-]{1,40}$/.test(symbol ?? '')
        && (direction === 'above' || direction === 'below') && Number.isFinite(level) && level > 0;
      if (!validSyntax) {
        replies.push({ chatId, text: 'Usage: /alert SYMBOL above|below LEVEL. Educational data only; not investment advice.' });
        return;
      }
      if (typeof isKnownSymbol === 'function' && !isKnownSymbol(symbol)) {
        replies.push({ chatId, text: `${escapeHtml(symbol)} is unknown or unsupported. Educational data only; not investment advice.`, parseMode: 'HTML' });
        return;
      }
      if (subscriber.alerts.length >= MAX_PERSONAL_ALERTS) {
        replies.push({ chatId, text: `Personal alert limit reached (${MAX_PERSONAL_ALERTS}). Use /unalert ID first. Educational data only; not investment advice.` });
        return;
      }
      let id;
      do { id = randomBytes(4).toString('hex'); }
      while (subscriber.alerts.some(alert => alert.id === id));
      subscriber.alerts.push({ id, symbol, direction, level, createdAt: now });
      replies.push({ chatId, text: `Personal alert <b>${id}</b> set: ${escapeHtml(symbol)} ${direction} ${level}. Educational data only; not investment advice.`, parseMode: 'HTML' });
      return;
    }

    const id = parsed.args.split(/\s+/).filter(Boolean)[0]?.toLowerCase();
    if (!id) {
      replies.push({ chatId, text: 'Usage: /unalert ID. Educational data only; not investment advice.' });
      return;
    }
    const index = subscriber.alerts.findIndex(alert => alert.id.toLowerCase() === id);
    if (index < 0) {
      replies.push({ chatId, text: `No personal alert with ID ${escapeHtml(id)}. Educational data only; not investment advice.`, parseMode: 'HTML' });
      return;
    }
    const [removed] = subscriber.alerts.splice(index, 1);
    replies.push({ chatId, text: `Personal alert <b>${escapeHtml(removed.id)}</b> removed. Educational data only; not investment advice.`, parseMode: 'HTML' });
    return;
  }

  if (maySendHint(chatId, now)) replies.push({ chatId, text: 'Unknown command. Use /help to see the available commands.' });
}

/** One crash-safe getUpdates pass. `handle` is an injectable fetch transport. */
export async function pollCommands({ token, statePath, now = Date.now(), log = () => {}, send, handle = globalThis.fetch, ownerChatId, handleLive, handleJournal, handleObs, handleOi, isKnownSymbol } = {}) {
  if (!token || !statePath || typeof handle !== 'function') return { processed: 0, offset: 0, skipped: 'not configured' };
  try {
    const before = loadSubscribers(statePath);
    const query = new URLSearchParams({
      offset: String(before.offset),
      timeout: '0',
      allowed_updates: JSON.stringify(['message']),
    });
    const response = await handle(`${TELEGRAM_API}/bot${token}/getUpdates?${query}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log(`telegram subscribers poll HTTP ${response.status}`);
      return { processed: 0, offset: before.offset, skipped: 'telegram error' };
    }
    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body.result)) {
      log('telegram subscribers poll returned an invalid response');
      return { processed: 0, offset: before.offset, skipped: 'invalid response' };
    }

    const updates = body.result.slice().sort((a, b) => (a?.update_id ?? 0) - (b?.update_id ?? 0));
    if (!updates.length) return { processed: 0, offset: before.offset, subscribers: before };

    const state = normalizeState(before);
    const replies = [];
    let lastUpdateId = before.offset - 1;
    for (const update of updates) {
      if (Number.isSafeInteger(update?.update_id)) lastUpdateId = Math.max(lastUpdateId, update.update_id);
      if (update?.message) processCommand(state, update.message, now, replies, ownerChatId, isKnownSymbol);
    }
    const next = { ...state, offset: lastUpdateId >= 0 ? lastUpdateId + 1 : before.offset };

    // Acknowledge Telegram only after command state and its offset are durable.
    try { saveSubscribers(statePath, next); }
    catch (error) {
      log(`telegram subscribers save failed; offset kept at ${before.offset}: ${String(error?.message || error)}`);
      return { processed: 0, offset: before.offset, skipped: 'save failed' };
    }

    const sendReply = typeof send === 'function' ? send : async () => ({ sent: false, reason: 'not-configured' });
    for (const reply of replies) {
      try {
        let text = reply.text;
        if (reply.live) {
          try {
            const result = await handleLive?.(reply.live.symbol, reply.live.side);
            text = typeof result === 'string'
              ? result
              : typeof result?.text === 'string'
                ? result.text
                : `${reply.live.symbol}: live snapshot unavailable with this provider.\n\n🎓 Educational data only; not investment advice.`;
          } catch {
            text = `${reply.live.symbol}: live snapshot unavailable with this provider.\n\n🎓 Educational data only; not investment advice.`;
          }
        }
        if (reply.journal) {
          try {
            const result = await handleJournal?.(now);
            text = typeof result === 'string'
              ? result
              : typeof result?.text === 'string'
                ? result.text
                : 'No outcomes resolved yet today.\n\n🎓 Observation history is educational only; not investment advice.';
          } catch {
            text = 'Journal outcomes are temporarily unavailable.\n\n🎓 Observation history is educational only; not investment advice.';
          }
        }
        if (reply.obs) {
          try {
            const result = await handleObs?.(reply.obs.symbol);
            text = typeof result === 'string' ? result : `${reply.obs.symbol}: no observations yet.\n\n🎓 Observation history is educational only; not investment advice.`;
          } catch {
            text = 'Observations are temporarily unavailable.\n\n🎓 Observation history is educational only; not investment advice.';
          }
        }
        if (reply.oi) {
          try {
            const result = await handleOi?.(reply.oi.symbol, reply.oi.strike);
            text = typeof result === 'string' ? result : `${reply.oi.symbol}: OI snapshot unavailable with this provider.\n\n🎓 Educational data only; not investment advice.`;
          } catch {
            text = 'OI data is temporarily unavailable.\n\n🎓 Educational data only; not investment advice.';
          }
        }
        const options = { chatId: reply.chatId, ...(reply.parseMode ? { parseMode: reply.parseMode } : {}) };
        const result = await sendReply(text, options);
        if (!result?.sent) log(`telegram subscriber reply not sent (${result?.reason ?? result?.status ?? 'unknown'})`);
      } catch (error) {
        log(`telegram subscriber reply failed: ${String(error?.message || error)}`);
      }
    }
    return { processed: updates.length, offset: next.offset, subscribers: next };
  } catch (error) {
    log(`telegram subscribers poll failed: ${String(error?.message || error)}`);
    return { processed: 0, offset: loadSubscribers(statePath).offset, skipped: 'poll failed' };
  }
}
