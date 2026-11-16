import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sendTelegram } from './telegram.mjs';

/**
 * The alert engine: evaluates a rules file against each freshly built market
 * file and turns matches into Telegram messages.
 *
 * Rules live in `<DATA_DIR>/alerts.json` and are re-read every evaluation, so
 * editing them needs no restart. Four rule types:
 *
 *   level    — the underlying's spot crossed a level      { above?, below? }
 *   buildup  — day price move and chain OI added the same way (LONG/SHORT
 *              build-up, the board's day floors: price ±0.5%, OI ±2%)
 *   oi-spike — strikes whose day OI change crosses a % floor (once per day)
 *   top-movers — ranked rising/falling underlyings with their chain OI
 *
 * Every rule carries an id and an escalating per-session cooldown; oi-spike
 * fires once per session date. State is in memory, so a restart re-arms rules.
 */

const MINUTE = 60_000;
const COOLDOWN_STEPS_MIN = [10, 30, 60];
const DAILY_FIRE_CAP = 6;
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

/** True inside the alert fire window (skips the volatile open, stops at 15:00 IST). */
export function inFireWindow(now) {
  const minute = istMinuteOfDay(now);
  return minute >= FIRE_FROM_MINUTE && minute <= FIRE_TO_MINUTE;
}

export function loadAlertRules(rulesPath) {
  const rules = readRuleFile(rulesPath);
  // Auto rules (TypeSafe triage) merge in: static file always wins on id and
  // on hand-written buildup coverage of the same symbol.
  const auto = readRuleFile(join(dirname(rulesPath), 'alerts.auto.json'))
    .filter(rule => rule?.auto === true && typeof rule?.symbol === 'string');
  if (!auto.length) return rules;
  const ids = new Set(rules.map(rule => rule.id));
  const staticBuildups = new Set(rules.filter(rule => rule?.type === 'buildup').map(rule => rule.symbol));
  return [...rules, ...auto.filter(rule => !ids.has(rule.id) && !staticBuildups.has(rule.symbol))];
}

function readRuleFile(rulesPath) {
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

/** Heaviest CE above spot and PE below spot; the shape mirrors the Observation wall read. */
function wallReadings(series) {
  const spot = series?.sp;
  if (!Number.isFinite(spot)) return { ce: null, pe: null };
  let ce = null;
  let pe = null;
  for (const row of series?.r ?? []) {
    if (!Array.isArray(row) || !Number.isFinite(row[0]) || !Number.isFinite(row[4]) || row[4] <= 0) continue;
    if (row[1] === 0 && row[0] >= spot && (!ce || row[4] > ce.oi)) ce = { strike: row[0], oi: row[4] };
    if (row[1] === 1 && row[0] <= spot && (!pe || row[4] > pe.oi)) pe = { strike: row[0], oi: row[4] };
  }
  return { ce, pe };
}

function wallOiText(value) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 100_000 ? `${(value / 100_000).toFixed(1)}L`
      : `${(value / 1000).toFixed(1)}K`;
}

function wallShiftMessage(rule, series, baseline, now) {
  if (!baseline) return null;
  const current = wallReadings(series);
  const changes = [];
  for (const [side, label] of [['ce', 'CE'], ['pe', 'PE']]) {
    const before = baseline[side];
    const after = current[side];
    if (!before && after) changes.push(`${label} wall appeared at ${after.strike} (OI ${wallOiText(after.oi)})`);
    else if (before && !after) changes.push(`${label} wall disappeared from ${before.strike}`);
    else if (before && after) {
      if (before.strike !== after.strike) changes.push(`${label} wall moved ${before.strike}→${after.strike}`);
      if (before.oi > 0) {
        const changePct = ((after.oi - before.oi) / before.oi) * 100;
        if (Math.abs(changePct) >= 25) changes.push(`${label} wall OI ${changePct >= 0 ? '+' : '−'}${Math.abs(changePct).toFixed(0)}% from first capture`);
      }
    }
  }
  if (!changes.length) return null;
  return `🚨 ${rule.label ?? `${rule.symbol} OI wall shift`}: ${changes.join('; ')} · ${clock(now)} IST`;
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

/** Every underlying with a readable day change and the chain OI it added. */
export function marketMovers(market) {
  const movers = [];
  for (const series of market?.series ?? []) {
    const spot = series.sp;
    const prevClose = series.pc;
    if (!Number.isFinite(spot) || !Number.isFinite(prevClose) || prevClose <= 0) continue;
    const changePct = ((spot - prevClose) / prevClose) * 100;
    const { oi, prev } = chainOi(series);
    if (!(prev > 0)) continue;
    const oiPct = ((oi - prev) / prev) * 100;
    const buildup = changePct >= PRICE_FLOOR_PCT && oiPct >= OI_FLOOR_PCT ? 'LONG BUILD-UP'
      : changePct <= -PRICE_FLOOR_PCT && oiPct >= OI_FLOOR_PCT ? 'SHORT BUILD-UP' : null;
    movers.push({ symbol: series.s, spot, changePct, oiAdded: oi - prev, oiPct, buildup });
  }
  return movers;
}

/**
 * The board's ranked movers as a digest: top N rising and top N falling
 * underlyings by day change, each with the chain OI it added. Frequency is
 * governed by the shared escalating per-rule cooldown.
 */
function topMoversMessage(rule, market, now) {
  const movers = marketMovers(market);
  const top = Math.max(1, rule.top ?? 10);
  const byUp = [...movers].sort((a, b) => b.changePct - a.changePct).slice(0, top);
  const byDown = [...movers].sort((a, b) => a.changePct - b.changePct).slice(0, top);
  const oiText = value => `${value >= 0 ? '+' : ''}${(value / 1_000_000).toFixed(2)}M`;
  const line = (list, face) => list.map((m, index) => `${index + 1}. ${m.symbol} ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}% OI${oiText(m.oiAdded)}`).join(` ${face} `);
  if (!byUp.length && !byDown.length) return null;
  return `📊 TOP MOVERS (day · ${clock(now)} IST)\n🟢 ${line(byUp, '▲')}\n🔴 ${line(byDown, '▼')}`;
}

/**
 * Evaluate one rules array against one market file. `state` maps each rule id
 * to its session day, last fire time, daily count, and cooldown step.
 */
export function evaluateAlerts(market, rules, state, now = Date.now(), { dailyCap = DAILY_FIRE_CAP, wallBaselines } = {}) {
  if (!inFireWindow(now)) return [];
  const fireCap = Number.isSafeInteger(dailyCap) && dailyCap >= 0 ? dailyCap : DAILY_FIRE_CAP;
  const messages = [];
  const dayKey = typeof market?.date === 'string' ? market.date : null;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule?.id !== 'string' || typeof rule?.type !== 'string') continue;
    // top-movers reads the whole market; every other type is per-symbol.
    const series = rule.type === 'top-movers' ? market : seriesFor(market, rule.symbol);
    if (rule.type !== 'top-movers' && !series) continue;
    const stored = state.get(rule.id);
    const current = stored && typeof stored === 'object' && stored.dayKey === dayKey
      ? stored
      : { dayKey, lastAt: null, firesToday: 0, step: 0 };
    if (current !== stored) state.set(rule.id, current);
    if (current.firesToday >= fireCap) continue;
    if (rule.type === 'oi-spike') {
      // The spike summary is a once-per-session digest, independent of cooldown.
      if (current.firesToday > 0) continue;
    } else if (Number.isFinite(current.lastAt)) {
      const step = Math.min(Math.max(0, current.step | 0), COOLDOWN_STEPS_MIN.length - 1);
      if (now - current.lastAt < COOLDOWN_STEPS_MIN[step] * MINUTE) continue;
    }
    let text = null;
    if (rule.type === 'level') text = levelMessage(rule, series, now);
    else if (rule.type === 'buildup') text = buildupMessage(rule, series, now);
    else if (rule.type === 'oi-spike') text = oiSpikeMessage(rule, series, now);
    else if (rule.type === 'wall-shift') text = wallShiftMessage(rule, series, wallBaselines?.get(rule.symbol), now);
    else if (rule.type === 'top-movers') text = topMoversMessage(rule, market, now);
    if (!text) continue;
    const firesToday = current.firesToday + 1;
    state.set(rule.id, {
      dayKey,
      lastAt: now,
      firesToday,
      // The first fire arms 10 minutes; each subsequent fire widens the gate.
      step: Math.min(firesToday - 1, COOLDOWN_STEPS_MIN.length - 1),
    });
    messages.push(text);
  }
  return messages;
}

export const BROADCAST_FOOTER = '📊 educational market-data digest · not investment advice · /stop to opt out';
const DIGEST_MINUTES = [11 * 60, 13 * 60, 15 * 60 + 45];
const ALERT_SECTIONS = [
  { type: 'level', heading: '🚨 <b>Level</b>' },
  { type: 'buildup', heading: '📈 <b>Build-ups</b>' },
  { type: 'oi-spike', heading: '⚡ <b>OI spikes</b>' },
  { type: 'wall-shift', heading: '🧱 <b>Wall shifts</b>' },
  { type: 'top-movers', heading: '📊 <b>Digest</b>' },
];

const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function rulesThatFired(rules, previous, state) {
  return rules.filter(rule => {
    const current = state.get(rule?.id);
    if (!current || typeof current !== 'object') return false;
    const prior = previous.get(rule.id);
    const priorCount = prior?.dayKey === current.dayKey ? prior.firesToday : 0;
    return current.firesToday > priorCount;
  });
}

function alertItems({ rule, text }, market) {
  const plain = String(text).replace(/^🚨\s*/, '').replace(/\s*· \d{2}:\d{2} IST$/, '');
  if (rule.type === 'level') {
    const colon = plain.indexOf(':');
    const label = colon >= 0 ? plain.slice(0, colon) : rule.label ?? rule.symbol;
    const detail = colon >= 0 ? plain.slice(colon + 1).trim() : plain;
    return [`• <b>${escapeHtml(label)}</b> ${escapeHtml(detail)}`];
  }
  if (rule.type === 'buildup') {
    const match = plain.match(/(LONG|SHORT) BUILD-UP: spot ([+-]\d+\.\d+%), chain OI ([+-]\d+\.\d+%)/);
    const mover = marketMovers(market).find(item => item.symbol === rule.symbol);
    const oiAdded = Math.abs(mover?.oiAdded ?? 0);
    const sign = (mover?.oiAdded ?? 0) >= 0 ? '+' : '−';
    const oi = mover
      ? `${sign}${oiAdded >= 1_000_000 ? `${(oiAdded / 1_000_000).toFixed(1)}M` : oiAdded >= 1000 ? `${(oiAdded / 1000).toFixed(1)}K` : oiAdded.toFixed(0)}`
      : match?.[3] ?? '';
    if (match) return [`• <b>${escapeHtml(rule.symbol ?? rule.label ?? '')}</b> ${escapeHtml(match[2])} · OI ${escapeHtml(oi)} · ${match[1].toLowerCase()}`];
    return [`• <b>${escapeHtml(rule.symbol ?? rule.label ?? '')}</b> ${escapeHtml(plain)}`];
  }
  if (rule.type === 'oi-spike') {
    const colon = plain.indexOf(':');
    const label = colon >= 0 ? plain.slice(0, colon) : rule.label ?? `${rule.symbol} OI spikes`;
    const detail = colon >= 0 ? plain.slice(colon + 1).trim() : plain;
    return [`• <b>${escapeHtml(label)}</b> ${escapeHtml(detail)}`];
  }
  if (rule.type === 'wall-shift') {
    const colon = plain.indexOf(':');
    const detail = colon >= 0 ? plain.slice(colon + 1).trim() : plain;
    return [`• <b>${escapeHtml(rule.symbol)}</b> ${escapeHtml(detail)}`];
  }
  if (rule.type === 'top-movers') {
    return String(text).split('\n').slice(1).map(line => {
      const content = line.replace(/^[🟢🔴]\s*/, '');
      const escaped = escapeHtml(content).replace(/(\d+\.\s*)([A-Z][A-Z0-9._-]*)/g, '$1<b>$2</b>');
      return `• ${escaped}`;
    }).filter(line => line !== '• ');
  }
  return [`• ${escapeHtml(plain)}`];
}

function combinedHtml(events, market, now, includeFooter) {
  const footer = includeFooter ? BROADCAST_FOOTER : '';
  const maxBody = 900 - (includeFooter ? footer.length + 2 : 0);
  let lines = [`📊 <b>Order Flow</b> · ${clock(now)} IST`];
  for (const section of ALERT_SECTIONS) {
    const items = events.filter(event => event.rule?.type === section.type)
      .flatMap(event => event.items ?? alertItems(event, market));
    if (!items.length) continue;
    const beforeSection = lines;
    const withHeading = [...lines, '', section.heading];
    if (withHeading.join('\n').length > maxBody) continue;
    lines = withHeading;
    let added = 0;
    for (const item of items) {
      const candidate = [...lines, item];
      if (candidate.join('\n').length > maxBody) break;
      lines = candidate;
      added++;
    }
    if (!added) lines = beforeSection;
  }
  const body = lines.join('\n');
  return includeFooter ? `${body}\n\n${footer}` : body;
}

const EOD_SECTIONS = [
  { type: 'top-movers', heading: '📊 <b>Top movers</b>' },
  { type: 'buildup', heading: '📈 <b>Build-ups</b>' },
  { type: 'wall-shift', heading: '🧱 <b>Wall shifts</b>' },
  { type: 'level', heading: '🚨 <b>Levels touched</b>' },
];

function boundedSectionBody(events, sections, heading, limit) {
  let lines = [heading];
  for (const section of sections) {
    const items = events.filter(event => event.rule?.type === section.type)
      .flatMap(event => event.items ?? []);
    if (!items.length) continue;
    const before = lines;
    const withHeading = [...lines, '', section.heading];
    if (withHeading.join('\n').length > limit) continue;
    lines = withHeading;
    let added = 0;
    for (let index = 0; index < items.length; index++) {
      const remaining = items.length - index - 1;
      const marker = remaining ? `• … ${remaining} more` : null;
      if ([...lines, items[index], ...(marker ? [marker] : [])].join('\n').length <= limit) {
        lines.push(items[index]);
        added++;
        continue;
      }
      const truncated = `• … ${items.length - index} more`;
      if ([...lines, truncated].join('\n').length <= limit) lines.push(truncated);
      break;
    }
    if (!added) lines = before;
  }
  return lines.join('\n');
}

function eodJournalBody(observations, date, limit) {
  const cards = (Array.isArray(observations) ? observations : []).filter(card => card?.date === date);
  const outcomes = cards.filter(card => card?.outcome && typeof card.outcome === 'object');
  const tally = status => outcomes.filter(card => card.outcome.status === status).length;
  const counts = `Cards written ${cards.length} · ${tally('tgt1')} TGT1 · ${tally('sl')} SL · ${tally('open')} open · ${tally('ambiguous')} ambiguous`;
  const lines = [`📓 <b>Journal outcomes</b> · ${escapeHtml(date)}`, counts];
  const items = outcomes.map(card => {
    const status = String(card.outcome.status ?? 'unknown').toUpperCase();
    const r = Number.isFinite(card.outcome.r) ? `${card.outcome.r >= 0 ? '+' : '−'}${Math.abs(card.outcome.r).toFixed(2)}` : '—';
    return `• <b>${escapeHtml(card.symbol)} ${escapeHtml(card.strike)}${card.side === 'PE' ? 'PE' : 'CE'}</b> · ${escapeHtml(status)} · R${r}`;
  });
  lines.push(`🔬 <b>Jev tally</b> · ${counts}`);
  for (let index = 0; index < items.length; index++) {
    const remaining = items.length - index - 1;
    const marker = remaining ? `• … ${remaining} more cards` : null;
    if ([...lines, items[index], ...(marker ? [marker] : [])].join('\n').length <= limit) {
      lines.push(items[index]);
      continue;
    }
    const truncated = `• … ${items.length - index} more cards`;
    if ([...lines, truncated].join('\n').length <= limit) lines.push(truncated);
    break;
  }
  return lines.join('\n');
}

function eodBroadcasts(digestState, observations, date, pendingEvents = []) {
  const limit = 900 - BROADCAST_FOOTER.length - 2;
  const dayEvents = [...new Map([
    ...pendingEvents.map(event => [`${event.rule?.type}:${event.rule?.id}`, event]),
    ...digestState.dailyEvents,
  ]).values()];
  const report = boundedSectionBody(dayEvents, EOD_SECTIONS, `📊 <b>15:45 EOD report</b> · ${escapeHtml(date)}`, limit);
  const journal = eodJournalBody(observations, date, limit);
  const combined = `${report}\n\n${journal}`;
  const bodies = combined.length <= limit ? [combined] : [report, journal];
  return bodies.map(body => `${body}\n\n${BROADCAST_FOOTER}`);
}

function recipientsFor(chatIds) {
  const ownerId = process.env.TELEGRAM_CHAT_ID == null ? null : String(process.env.TELEGRAM_CHAT_ID);
  return [...new Set((Array.isArray(chatIds) ? chatIds : [])
    .map(Number)
    .filter(chatId => Number.isSafeInteger(chatId) && chatId !== 0 && String(chatId) !== ownerId))];
}

export function createAlertDigestState() {
  return { dayKey: null, pending: new Map(), dailyEvents: new Map(), wallBaselines: new Map(), personalAlertStates: new Map(), sentSlots: new Set() };
}

function prepareDigestState(state, dayKey) {
  if (!(state.pending instanceof Map)) state.pending = new Map();
  if (!(state.dailyEvents instanceof Map)) state.dailyEvents = new Map();
  if (!(state.wallBaselines instanceof Map)) state.wallBaselines = new Map();
  if (!(state.personalAlertStates instanceof Map)) state.personalAlertStates = new Map();
  if (!(state.sentSlots instanceof Set)) state.sentSlots = new Set();
  if (state.dayKey !== dayKey) {
    state.dayKey = dayKey;
    state.pending.clear();
    state.dailyEvents.clear();
    state.wallBaselines.clear();
    state.sentSlots.clear();
  }
}

function istDateKey(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function safeLogResult(log, prefix, result) {
  log(`${prefix} ${result?.sent ? 'sent' : `not sent (${result?.reason ?? result?.status ?? 'unknown'})`}`);
}

/** Evaluate one market snapshot, send one owner batch, and route subscriber events by cadence. */
export async function runAlerts(market, {
  rulesPath,
  state,
  now = Date.now(),
  log = () => {},
  send = sendTelegram,
  broadcastChatIds = [],
  subscriberEntries = [],
  digestState,
}) {
  const rules = loadAlertRules(rulesPath);
  const subscribers = recipientsFor(broadcastChatIds);
  let rulesForEvaluation = rules;
  let wallBaselines;
  if (digestState && subscribers.length && typeof market?.date === 'string') {
    prepareDigestState(digestState, market.date);
    const watchedSymbols = new Set(['NIFTY', 'BANKNIFTY', ...rules
      .filter(rule => rule?.type === 'buildup' && rule.broadcast === true && typeof rule.symbol === 'string')
      .map(rule => rule.symbol)]);
    for (const symbol of watchedSymbols) {
      if (digestState.wallBaselines.has(symbol)) continue;
      const series = seriesFor(market, symbol);
      if (series) digestState.wallBaselines.set(symbol, wallReadings(series));
    }
    const existingIds = new Set(rules.map(rule => rule?.id));
    const wallRules = [...watchedSymbols]
      .map(symbol => ({ id: `wall-shift:${symbol}`, type: 'wall-shift', symbol, label: `${symbol} OI wall shift`, broadcast: true }))
      .filter(rule => !existingIds.has(rule.id));
    rulesForEvaluation = [...rules, ...wallRules];
    wallBaselines = digestState.wallBaselines;
  }
  const previous = new Map(state);
  const messages = evaluateAlerts(market, rulesForEvaluation, state, now, { wallBaselines });
  const firedRules = rulesThatFired(rulesForEvaluation, previous, state);
  const events = messages.map((text, index) => ({ text, rule: firedRules[index] ?? { type: 'unknown' } }));

  if (events.length) {
    const ownerMessage = combinedHtml(events, market, now, false);
    try {
      safeLogResult(log, 'telegram owner', await send(ownerMessage, { parseMode: 'HTML', retry: true }));
    } catch (error) {
      log(`telegram owner not sent (${String(error?.message || error)})`);
    }
  }

  const instant = events.filter(event => event.rule.broadcast === true
    && (event.rule.type === 'oi-spike' || (event.rule.type === 'level' && event.rule.symbol === 'NIFTY')));
  if (digestState && subscribers.length && typeof market?.date === 'string') {
    const daily = events.filter(event => event.rule.broadcast === true && ['level', 'buildup', 'top-movers', 'wall-shift'].includes(event.rule.type));
    for (const event of daily) {
      const key = `${event.rule.type}:${event.rule.id}`;
      const prepared = { ...event, items: alertItems(event, market) };
      digestState.dailyEvents.set(key, prepared);
      if (['buildup', 'top-movers', 'wall-shift'].includes(event.rule.type)) digestState.pending.set(key, prepared);
    }
  }
  if (instant.length) {
    const subscriberMessage = combinedHtml(instant, market, now, true);
    for (const chatId of subscribers) {
      await pause(30);
      try {
        safeLogResult(log, `telegram instant subscriber ${chatId}`, await send(subscriberMessage, { chatId, parseMode: 'HTML', retry: true }));
      } catch (error) {
        log(`telegram instant subscriber ${chatId} not sent (${String(error?.message || error)})`);
      }
    }
  }

  if (digestState && !(digestState.personalAlertStates instanceof Map)) digestState.personalAlertStates = new Map();
  const personalStates = digestState?.personalAlertStates ?? new Map();
  for (const subscriber of Array.isArray(subscriberEntries) ? subscriberEntries : []) {
    const chatId = Number(subscriber?.chatId);
    if (!subscriber?.active || !Number.isSafeInteger(chatId) || !Array.isArray(subscriber.alerts) || !subscriber.alerts.length) continue;
    const rulesForSubscriber = subscriber.alerts.map(alert => ({
      id: `subscriber:${chatId}:${alert.id}`,
      type: 'level',
      symbol: alert.symbol,
      ...(alert.direction === 'above' ? { above: alert.level } : { below: alert.level }),
      label: `${alert.symbol} ${alert.direction} ${alert.level}`,
    }));
    const stateForSubscriber = personalStates.get(String(chatId)) ?? new Map();
    personalStates.set(String(chatId), stateForSubscriber);
    const before = new Map(stateForSubscriber);
    const personalMessages = evaluateAlerts(market, rulesForSubscriber, stateForSubscriber, now, { dailyCap: 5 });
    if (!personalMessages.length) continue;
    const personalRules = rulesThatFired(rulesForSubscriber, before, stateForSubscriber);
    const personalEvents = personalMessages.map((text, index) => ({ text, rule: personalRules[index] ?? rulesForSubscriber[index] }));
    const personalMessage = combinedHtml(personalEvents, market, now, true);
    await pause(30);
    try {
      safeLogResult(log, `telegram personal alerts ${chatId}`, await send(personalMessage, { chatId, parseMode: 'HTML', retry: true }));
    } catch (error) {
      log(`telegram personal alerts ${chatId} not sent (${String(error?.message || error)})`);
    }
  }
  return messages;
}

/** Flush queued build-up/top-mover items and the 15:45 subscriber EOD report. */
export async function flushScheduledDigests({ digestState, now = Date.now(), broadcastChatIds = [], observations = [], send = sendTelegram, log = () => {} } = {}) {
  if (!digestState) return { sent: 0, skipped: 'no digest state' };
  const dayKey = istDateKey(now);
  prepareDigestState(digestState, dayKey);
  const currentMinute = istMinuteOfDay(now);
  const dueSlots = DIGEST_MINUTES.filter(minute => minute <= currentMinute && !digestState.sentSlots.has(minute));
  if (!dueSlots.length) return { sent: 0, skipped: 'not due' };

  for (const minute of dueSlots) digestState.sentSlots.add(minute);
  const events = [...digestState.pending.values()];
  digestState.pending.clear();
  const subscribers = recipientsFor(broadcastChatIds);
  if (!subscribers.length) return { sent: 0, skipped: 'empty' };

  if (dueSlots.includes(15 * 60 + 45)) {
    const messages = eodBroadcasts(digestState, observations, dayKey, events);
    for (const chatId of subscribers) {
      for (const message of messages) {
        await pause(30);
        try {
          safeLogResult(log, `telegram EOD subscriber ${chatId}`, await send(message, { chatId, parseMode: 'HTML', retry: true }));
        } catch (error) {
          log(`telegram EOD subscriber ${chatId} not sent (${String(error?.message || error)})`);
        }
      }
    }
    return { sent: subscribers.length * messages.length, slots: dueSlots, messages: messages.length };
  }

  if (!events.length) return { sent: 0, skipped: 'empty' };

  const message = combinedHtml(events, null, now, true);
  for (const chatId of subscribers) {
    await pause(30);
    try {
      safeLogResult(log, `telegram digest subscriber ${chatId}`, await send(message, { chatId, parseMode: 'HTML', retry: true }));
    } catch (error) {
      log(`telegram digest subscriber ${chatId} not sent (${String(error?.message || error)})`);
    }
  }
  return { sent: subscribers.length, slots: dueSlots };
}
