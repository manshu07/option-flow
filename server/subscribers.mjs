import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_SUBSCRIBERS = 500;
const HINT_LIMIT = 3;
const HINT_WINDOW_MS = 60 * 60_000;
const hintTimes = new Map();

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
  const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(String(text ?? '').trim());
  return match?.[1]?.toLowerCase() ?? null;
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

function processCommand(state, message, now, replies) {
  const chatId = Number(message?.chat?.id);
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  const command = commandFor(message?.text);
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
    replies.push({ chatId, text: '/start subscribe · /stop unsubscribe · /help show commands\nFree educational market-data digests only; not investment advice.' });
    return;
  }

  if (maySendHint(chatId, now)) replies.push({ chatId, text: 'Unknown command. Use /help to see the available commands.' });
}

/** One crash-safe getUpdates pass. `handle` is an injectable fetch transport. */
export async function pollCommands({ token, statePath, now = Date.now(), log = () => {}, send, handle = globalThis.fetch } = {}) {
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
      if (update?.message) processCommand(state, update.message, now, replies);
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
        const result = await sendReply(reply.text, { chatId: reply.chatId });
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
