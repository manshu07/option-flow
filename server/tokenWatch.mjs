/**
 * Dhan token watch — the access token is valid for exactly 24 hours, and the
 * server keeps using whatever it read at boot, so an expired token silently
 * 401s until someone regenerates it and restarts.
 *
 * This module turns the token's own JWT expiry into a reminder (boot warning,
 * `/api/health` field, one Telegram note) instead of leaving it to memory.
 */

const HOUR = 3_600_000;

/** Decode a JWT's `exp` without verifying the signature (we only read our own token). */
export function tokenExpiryAt(token) {
  if (typeof token !== 'string' || !token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

export function hoursLeft(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return null;
  return Number(((expiresAt - now) / HOUR).toFixed(2));
}

/**
 * The reminder to send, or null. Two windows:
 *  - `soon` (default ≤6h): tomorrow-morning warning, one per day
 *  - `urgent` (default ≤1h): the token dies during the session
 */
export function tokenReminder({ expiresAt, now = Date.now(), alreadySent = false, soonHours = 6, urgentHours = 1 } = {}) {
  if (alreadySent) return null;
  const left = hoursLeft(expiresAt, now);
  if (left == null) return null;
  if (left <= 0) {
    return { level: 'expired', hoursLeft: left, text: '⛔ Dhan token has expired. Prices will stop at the next 401 — generate a fresh token (web.dhan.co → My Profile → DhanHQ Trading Access), paste it into .env, and restart the server.' };
  }
  if (left <= urgentHours) {
    return { level: 'urgent', hoursLeft: left, text: `⏰ Dhan token expires in about ${Math.max(1, Math.round(left * 60))} minutes. Generate a fresh one now and restart the server before the next session.` };
  }
  if (left <= soonHours) {
    return { level: 'soon', hoursLeft: left, text: `🔑 Dhan token expires in about ${Math.round(left)} hours. Regenerate it before the next market open — the server keeps the old one until it restarts.` };
  }
  return null;
}