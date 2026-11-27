/**
 * Telegram delivery for the alert engine — the only outbound network call the
 * board makes besides its data provider. Unconfigured (no bot token or no
 * chat id in .env) it is a silent no-op, so the feature can ship switched
 * off and nothing else changes.
 */

import { observationCaption } from './observationCardSvg.mjs';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TELEGRAM_API = 'https://api.telegram.org';

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Send one protected text message; optional subscriber routing/HTML is additive. */
// MESSAGE LOG BOOK (owner 2026-11-27): every outgoing message is appended here —
// one JSON line per send with chat, first 200 chars of text, parse mode and the
// Telegram result. This is the single choke point; all paths route through it.
const TG_LOG = path.join(process.env.MF_DATA_DIR ?? path.join(process.cwd(), 'server', 'data'), 'telegram-log.jsonl');
function logMessage(recipient, text, parseMode, result) {
  try {
    mkdirSync(path.dirname(TG_LOG), { recursive: true });
    writeFileSync(TG_LOG, JSON.stringify({ at: new Date().toISOString(), chat: String(recipient), parseMode: parseMode ?? null, ok: Boolean(result?.sent ?? result?.ok), desc: result?.description ?? null, text: String(text).slice(0, 200) }) + '\n', { flag: 'a' });
  } catch { /* logging must never break sending */ }
}

export async function sendTelegram(text, { chatId, parseMode, retry = true } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const recipient = chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || recipient == null || String(recipient) === '') return { sent: false, reason: 'not-configured' };
  const payload = { chat_id: recipient, text, protect_content: true };
  if (parseMode) payload.parse_mode = parseMode;
  const attempts = retry === false ? 1 : 2;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        let waitMs = 1000;
        if (response.status === 429) {
          const body = await response.json().catch(() => null);
          const retryAfter = Number(body?.parameters?.retry_after);
          if (Number.isFinite(retryAfter) && retryAfter >= 0) waitMs = retryAfter * 1000;
        }
        await delay(waitMs);
        continue;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        logMessage(recipient, text, parseMode, { sent: false, description: body?.description ?? ('http ' + response.status) });
        return { sent: false, status: response.status };
      }
      logMessage(recipient, text, parseMode, { sent: true });
      return { sent: true };
    } catch (error) {
      if (attempt + 1 < attempts) {
        await delay(1000);
        continue;
      }
      logMessage(recipient, text, parseMode, { sent: false, description: error?.message || 'error' });
      return { sent: false, reason: error?.message || 'error' };
    }
  }
  logMessage(recipient, text, parseMode, { sent: false, description: 'exhausted' });
  return { sent: false, reason: 'error' };
}

/** Send one owner-only Observation card as protected HTML text. */
export async function sendTelegramObservationCard(card) {
  if (!telegramConfigured()) return { sent: false, reason: 'not-configured' };
  return sendTelegram(observationCaption(card), { parseMode: 'HTML', retry: true });
}
