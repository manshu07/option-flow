/**
 * Telegram delivery for the alert engine — the only outbound network call the
 * board makes besides its data provider. Unconfigured (no bot token or no
 * chat id in .env) it is a silent no-op, so the feature can ship switched
 * off and nothing else changes.
 */

import { observationCaption } from './observationCardSvg.mjs';

const TELEGRAM_API = 'https://api.telegram.org';

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Send one protected text message; optional subscriber routing/HTML is additive. */
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
      if (!response.ok) return { sent: false, status: response.status };
      return { sent: true };
    } catch (error) {
      if (attempt + 1 < attempts) {
        await delay(1000);
        continue;
      }
      return { sent: false, reason: error?.message || 'error' };
    }
  }
  return { sent: false, reason: 'error' };
}

/** Send one owner-only Observation card as protected HTML text. */
export async function sendTelegramObservationCard(card) {
  if (!telegramConfigured()) return { sent: false, reason: 'not-configured' };
  return sendTelegram(observationCaption(card), { parseMode: 'HTML', retry: true });
}
