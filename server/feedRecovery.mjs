/**
 * Full-drop feed recovery decision (pure).
 *
 * The Dhan provider's per-connection watchdog reconnects individual silent
 * sockets, but a state where EVERY connection is gone/stuck (0/5 open) needs a
 * full re-init — HTTP stays 200 while the board goes stale. This decides when
 * that re-init is due: only in a market session, only after the feed has been
 * unhealthy for 90s, and at most once per 120s (cooldown) so a refusing endpoint
 * is never hammered with re-init storms.
 */
export const FEED_DOWN_REINIT_MS = 90_000;
export const FEED_REINIT_COOLDOWN_MS = 120_000;

export function feedReinitDue(now, { inSession, healthy, downSince = 0, lastReinitAt = 0, inFlight = false }) {
  if (!inSession || healthy) return { due: false, downSince: 0 };
  const since = downSince || now;
  const due = !inFlight && now - since > FEED_DOWN_REINIT_MS && now - lastReinitAt > FEED_REINIT_COOLDOWN_MS;
  return { due, downSince: since };
}