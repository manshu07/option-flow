import { isTradingDay, marketParts } from '../src/lib/marketSession.ts';

const DAY_MS = 24 * 60 * 60_000;
const FRIDAY = 5;
const REVIEW_MINUTE = 15 * 60 + 50;
const OUTCOME_STATUSES = new Set(['tgt1', 'sl', 'open', 'ambiguous']);

function dateNoon(dateKey) {
  const at = Date.parse(`${dateKey}T12:00:00+05:30`);
  return Number.isFinite(at) ? at : null;
}

export function lastFiveTradingDates(now) {
  let cursor = dateNoon(marketParts(now).dateKey);
  if (cursor == null) return [];
  const dates = [];
  for (let attempts = 0; dates.length < 5 && attempts < 20; attempts++, cursor -= DAY_MS) {
    const date = marketParts(cursor).dateKey;
    if (isTradingDay(new Date(cursor))) dates.push(date);
  }
  return dates.reverse();
}

export function weeklyReviewDue(now, sentDate = null) {
  try {
    const parts = marketParts(now);
    const noon = dateNoon(parts.dateKey);
    if (noon == null || new Date(noon).getUTCDay() !== FRIDAY || !isTradingDay(new Date(now))) return null;
    if (parts.minuteOfDay < REVIEW_MINUTE || parts.dateKey === sentDate) return null;
    return parts.dateKey;
  } catch {
    return null;
  }
}

function stableCardOrder(a, b) {
  return String(a.date).localeCompare(String(b.date))
    || String(a.symbol).localeCompare(String(b.symbol))
    || Number(a.strike) - Number(b.strike)
    || String(a.side).localeCompare(String(b.side));
}

function formatR(value) {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function cardName(card) {
  return `${card.symbol} ${card.strike}${card.side === 'PE' ? 'PE' : 'CE'}`;
}

/** Return null until there are at least three resolved cards in the five-session window. */
export function weeklyReviewMessage(cards, now) {
  const dates = lastFiveTradingDates(now);
  if (dates.length < 5) return null;
  const dateSet = new Set(dates);
  const written = (Array.isArray(cards) ? cards : []).filter(card => dateSet.has(card?.date));
  const resolved = written.filter(card => OUTCOME_STATUSES.has(card?.outcome?.status));
  if (resolved.length < 3) return null;

  const tgt1 = resolved.filter(card => card.outcome.status === 'tgt1').length;
  const ambiguous = resolved.filter(card => card.outcome.status === 'ambiguous').length;
  const stops = resolved.filter(card => card.outcome.status === 'sl').length + ambiguous;
  const open = resolved.filter(card => card.outcome.status === 'open').length;
  const finiteR = resolved.filter(card => Number.isFinite(card.outcome.r)).slice().sort((a, b) => a.outcome.r - b.outcome.r || stableCardOrder(a, b));
  const averageR = finiteR.length ? finiteR.reduce((sum, card) => sum + card.outcome.r, 0) / finiteR.length : null;
  const best = finiteR.at(-1);
  const worst = finiteR[0];
  const window = `${dates[0]}–${dates[dates.length - 1]}`;
  const lines = [
    `📅 Weekly journal · ${window} (${dates.length} sessions)`,
    `Cards written ${written.length} · resolved ${resolved.length}`,
    `TGT1 ${tgt1} · SL ${stops}${ambiguous ? ` (includes ${ambiguous} ambiguous)` : ''} · open ${open}`,
    `Average R ${averageR == null ? '—' : formatR(averageR)} across ${finiteR.length} scored outcomes`,
    `Best ${best ? `${cardName(best)} R${formatR(best.outcome.r)}` : 'n/a'}`,
    `Worst ${worst ? `${cardName(worst)} R${formatR(worst.outcome.r)}` : 'n/a'}`,
  ];
  return lines.join('\n');
}
