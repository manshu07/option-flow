import { isTradingDay, marketParts } from '../src/lib/marketSession.ts';

const WATCHED_INDEXES = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Returns the IST session date only once, on its 09:20 minute. */
export function gapOpenDue(now, lastSentDate = null) {
  try {
    const parts = marketParts(now);
    return isTradingDay(new Date(now)) && parts.minuteOfDay === 9 * 60 + 20 && parts.dateKey !== lastSentDate
      ? parts.dateKey
      : null;
  } catch {
    return null;
  }
}

/** Build one captured-data gap message; no provider calls are made. */
export function gapOpenMessage(market, date) {
  const lines = [];
  for (const series of Array.isArray(market?.series) ? market.series : []) {
    if (!WATCHED_INDEXES.has(series?.s) || !Number.isFinite(series.sp) || !Number.isFinite(series.pc) || series.pc <= 0) continue;
    const changePct = ((series.sp - series.pc) / series.pc) * 100;
    if (changePct >= 1) lines.push(`• 🌅 <b>${escapeHtml(series.s)}</b> gap-up +${changePct.toFixed(1)}% vs Friday close ${series.pc}`);
    else if (changePct <= -1) lines.push(`• 🌅 <b>${escapeHtml(series.s)}</b> gap-down −${Math.abs(changePct).toFixed(1)}% vs Friday close ${series.pc}`);
  }
  if (!lines.length) return null;
  return [`<b>Gap open · ${escapeHtml(date)} · 09:20 IST</b>`, ...lines].join('\n');
}
