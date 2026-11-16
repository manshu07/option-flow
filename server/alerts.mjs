import { readFileSync } from 'node:fs';
import { sendTelegram } from './telegram.mjs';

/**
 * The alert engine: evaluates a rules file against each freshly built market
 * file and turns matches into Telegram messages.
 *
 * Rules live in `<DATA_DIR>/alerts.json` and are re-read every evaluation, so
 * editing them needs no restart. Three rule types:
 *
 *   level    — the underlying's spot crossed a level      { above?, below? }
 *   buildup  — day price move and chain OI added the same way (LONG/SHORT
 *              build-up, the board's day floors: price ±0.5%, OI ±2%)
 *   oi-spike — strikes whose day OI change crosses a % floor (once per day)
 *
 * Every rule carries an id and a 10-minute cooldown; oi-spike fires once per
 * session date. Cooldown state is in memory: a restart re-arms everything.
 */

const MINUTE = 60_000;
const COOLDOWN_MS = 10 * MINUTE;
/** Day floors, mirroring the board's own build-up day defaults. */
const PRICE_FLOOR_PCT = 0.5;
const OI_FLOOR_PCT = 2;

const istClock = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const clock = ms => istClock.format(ms);
/** Alerts fire only inside this IST window: skip the volatile first 15 minutes after open, last fire 15:00. */
const FIRE_FROM_MINUTE = 9 * 60 + 30;
const FIRE_TO_MINUTE = 15 * 60;

function istMinuteOfDay(now) {
  const parts = istClock.formatToParts(now);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function loadAlertRules(rulesPath) {
  try {
    const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

function seriesFor(market, symbol) {
  return (market?.series ?? []).find(item => item?.s === symbol) ?? null;
}

function chainOi(series) {
  let oi = 0;
  let prev = 0;
  for (const row of series?.r ?? []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const oiNow = row[4];
    const oiPrev = row[5];
    if (!Number.isFinite(oiNow)) continue;
    oi += oiNow;
    if (Number.isFinite(oiPrev)) prev += oiPrev;
  }
  return { oi, prev };
}

function levelMessage(rule, series, now) {
  const spot = series.sp;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const above = Number.isFinite(rule.above) && spot >= rule.above;
  const below = Number.isFinite(rule.below) && spot <= rule.below;
  if (!above && !below) return null;
  const level = above ? rule.above : rule.below;
  const arrow = above ? '↑ above' : '↓ below';
  return `🚨 ${rule.label ?? rule.symbol}: spot ${spot} ${arrow} ${level} · ${clock(now)} IST`;
}

function buildupMessage(rule, series, now) {
  const spot = series.sp;
  const prevClose = series.pc;
  if (!Number.isFinite(spot) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
  const changePct = ((spot - prevClose) / prevClose) * 100;
  const { oi, prev } = chainOi(series);
  if (!(prev > 0)) return null;
  const oiPct = ((oi - prev) / prev) * 100;
  const long = changePct >= PRICE_FLOOR_PCT && oiPct >= OI_FLOOR_PCT;
  const short = changePct <= -PRICE_FLOOR_PCT && oiPct >= OI_FLOOR_PCT;
  if (!long && !short) return null;
  const label = long ? 'LONG BUILD-UP' : 'SHORT BUILD-UP';
  const sign = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  return `🚨 ${rule.label ?? rule.symbol} ${label}: spot ${sign(changePct)}, chain OI ${sign(oiPct)} · ${clock(now)} IST`;
}

function oiSpikeMessage(rule, series, now) {
  const rows = [];
  for (const row of series?.r ?? []) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const oiNow = row[4];
    const oiPrev = row[5];
    if (!Number.isFinite(oiNow) || !Number.isFinite(oiPrev) || oiPrev <= 0) continue;
    const pct = ((oiNow - oiPrev) / oiPrev) * 100;
    if (Number.isFinite(rule.oiChangePctMin) && pct < rule.oiChangePctMin) continue;
    if (Number.isFinite(rule.oiMin) && oiNow < rule.oiMin) continue;
    rows.push({ strike: row[0], side: row[1] === 0 ? 'CE' : 'PE', pct, oi: oiNow });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.pct - a.pct);
  const top = rows.slice(0, Math.max(1, rule.top ?? 3));
  const detail = top.map(item => `${item.strike}${item.side} ${item.pct >= 0 ? '+' : ''}${item.pct.toFixed(0)}% (${(item.oi / 100_000).toFixed(1)}L)`).join(', ');
  return `🚨 ${rule.label ?? `${rule.symbol} OI spikes`}: ${detail} · ${clock(now)} IST`;
}

/**
 * The board's ranked movers as a digest: top N rising and top N falling
 * underlyings by day change, each with the chain OI it added. One message
 * per rule.cooldownMin (default 30 minutes).
 */
function topMoversMessage(rule, market, now) {
  const movers = [];
  for (const series of market?.series ?? []) {
    const spot = series.sp;
    const prevClose = series.pc;
    if (!Number.isFinite(spot) || !Number.isFinite(prevClose) || prevClose <= 0) continue;
    const changePct = ((spot - prevClose) / prevClose) * 100;
    const { oi, prev } = chainOi(series);
    if (!(prev > 0)) continue;
    const oiAdded = oi - prev;
    movers.push({ symbol: series.s, changePct, oiAdded });
  }
  const top = Math.max(1, rule.top ?? 10);
  const byUp = [...movers].sort((a, b) => b.changePct - a.changePct).slice(0, top);
  const byDown = [...movers].sort((a, b) => a.changePct - b.changePct).slice(0, top);
  const oiText = value => `${value >= 0 ? '+' : ''}${(value / 1_000_000).toFixed(2)}M`;
  const line = (list, face) => list.map((m, index) => `${index + 1}. ${m.symbol} ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}% OI${oiText(m.oiAdded)}`).join(` ${face} `);
  if (!byUp.length && !byDown.length) return null;
  return `📊 TOP MOVERS (day · ${clock(now)} IST)\n🟢 ${line(byUp, '▲')}\n🔴 ${line(byDown, '▼')}`;
}

/**
 * Evaluate one rules array against one market file. `state` is a Map of
 * rule id → last fired (ms): 10-minute cooldown for level/buildup rules,
 * once-per-session-date for oi-spike. Returns the messages to send.
 */
export function evaluateAlerts(market, rules, state, now = Date.now()) {
  if (istMinuteOfDay(now) < FIRE_FROM_MINUTE || istMinuteOfDay(now) > FIRE_TO_MINUTE) return [];
  const messages = [];
  const dayKey = typeof market?.date === 'string' ? market.date : null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule?.id !== 'string' || typeof rule?.type !== 'string') continue;
    // top-movers reads the whole market; every other type is per-symbol.
    const series = rule.type === 'top-movers' ? market : seriesFor(market, rule.symbol);
    if (rule.type !== 'top-movers' && !series) continue;
    const last = state.get(rule.id) ?? 0;
    const dayKeyId = `${rule.id}|${dayKey}`;
    const cooldownMs = Number.isFinite(rule.cooldownMin) ? rule.cooldownMin * MINUTE : COOLDOWN_MS;
    if (rule.type === 'oi-spike') {
      // Once per session date: the summary would otherwise repeat all day.
      if (state.has(dayKeyId)) continue;
    } else if (now - last < cooldownMs) continue;
    let text = null;
    if (rule.type === 'level') text = levelMessage(rule, series, now);
    else if (rule.type === 'buildup') text = buildupMessage(rule, series, now);
    else if (rule.type === 'oi-spike') text = oiSpikeMessage(rule, series, now);
    else if (rule.type === 'top-movers') text = topMoversMessage(rule, market, now);
    if (!text) continue;
    state.set(rule.type === 'oi-spike' ? dayKeyId : rule.id, now);
    messages.push(text);
  }
  return messages;
}

/**
 * Evaluate + deliver. Telegram failures are logged and retried on the next
 * build's evaluation (cooldown state was already consumed, so a failed send
 * is the only chance a missed alert has — hence send before arming is not
 * done here: the caller decides delivery and logs).
 */
export async function runAlerts(market, { rulesPath, state, now = Date.now(), log = () => {}, send = sendTelegram }) {
  const rules = loadAlertRules(rulesPath);
  if (!rules.length) return [];
  const messages = evaluateAlerts(market, rules, state, now);
  for (const text of messages) {
    const result = await send(text);
    log(`telegram ${result.sent ? 'sent' : `not sent (${result.reason ?? result.status})`}: ${text}`);
  }
  return messages;
}
