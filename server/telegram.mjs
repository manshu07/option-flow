/**
 * Telegram delivery for the alert engine — the only outbound network call the
 * board makes besides its data provider. Unconfigured (no bot token or no
 * chat id in .env) it is a silent no-op, so the feature can ship switched
 * off and nothing else changes.
 */

const TELEGRAM_API = 'https://api.telegram.org';

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** Send one text message. Never throws — the caller logs the outcome. */
export async function sendTelegram(text) {
  if (!telegramConfigured()) return { sent: false, reason: 'not-configured' };
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { sent: false, status: response.status };
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error?.message || 'error' };
  }
}
