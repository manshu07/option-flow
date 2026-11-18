import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sendTelegram, sendTelegramObservationCard } from './telegram.mjs';
import { observationSubscriberCaption } from './observationCardSvg.mjs';
import { askTypeSafe, typesafeConfigured } from './typesafe.mjs';
import { inFireWindow, marketMovers } from './alerts.mjs';
import { gammaProfile, gammaRiskFreeRate, parseGammaSymbols } from '../src/features/market-flow/gammaModel.ts';
import { atrSummary } from '../src/features/market-flow/atrModel.ts';

/**
 * Strike setup advisor — observation cards for watched symbols, buy-side only.
 *
 * When the TypeSafe triage promotes a symbol to a watch rule, the advisor reads
 * that symbol's captured chain and:
 *
 *   1. code builds the candidate strikes (buy-side only: ATM±2 on the bias's
 *      side) and computes every number on the card — entry, the −45% stop,
 *      +55%/+90% targets, the TSL rule, and the chain's support/resistance
 *      walls (heaviest PE below spot, heaviest CE above spot);
 *   2. Jev judges (one request for the whole pass): does premium + OI confirm
 *      this setup, and which candidate fits a short-horizon momentum trade;
 *   3. code routes: quality ≥ 0.65 and a decisive strike pick → an observation
 *      card in <DATA_DIR>/observations.json plus one Telegram note per symbol
 *      per session date. Below the gate → nothing is written.
 *
 * These cards are structured observations of the captured chain, not trade
 * advice; every card carries that disclaimer.
 */

const MINUTE = 60_000;
const STOP_FRACTION = 0.45;   // stop at −45% of entry premium (user's −40–50% rule)
const TGT1_FRACTION = 0.55;   // first target +55%
const TGT2_FRACTION = 0.9;    // second target +90%
const MIN_ENTRY_PREMIUM = 0.5; // skip near-zero premiums — no lottery strikes
// Liquidity gate (P0-S2): dust strikes are never candidates.
const LIQUIDITY_MIN_OI = 10_000;
const LIQUIDITY_MIN_VOLUME = 1_000;
const LIQUIDITY_MAX_SPREAD_PCT = 2;
// ATR/delta-aware levels (P0-S2): premium move ≈ underlying ATR × |delta|.
const ATR_STOP_MULT = 1.0;
const ATR_TGT1_MULT = 1.5;
const ATR_TGT2_MULT = 2.5;
const QUALITY_YES = 0.65;
const PICK_MIN = 0.5;
const MAX_CARDS = 50;

const DISCLAIMER = 'Educational observation from captured OI/price data — not trade advice. Final call and risk are yours.';

const round2 = value => Math.round(value * 100) / 100;

function chainRows(series) {
  return (series?.r ?? []).filter(row => Array.isArray(row) && row.length >= 7 && Number.isFinite(row[0]));
}

/** Median gap between sorted strikes — the chain's step size. */
function strikeStep(strikes) {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  if (sorted.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 0;
}

/** Buy-side candidates around ATM on the bias's side: strike, side, ltp, oi change. */
export function candidateStrikes(series, bias) {
  const spot = series?.sp;
  const atm = series?.atm;
  if (!Number.isFinite(spot) || !Number.isFinite(atm)) return [];
  const side = bias === 'bearish' ? 1 : 0; // bearish → PE (side 1), bullish → CE (side 0)
  const rows = chainRows(series).filter(row => row[1] === side && Number.isFinite(row[2]) && row[2] > MIN_ENTRY_PREMIUM);
  const step = strikeStep(rows.map(row => row[0])) || 1;
  const byStrike = new Map(rows.map(row => [row[0], row]));
  const candidates = [];
  // ATM first, then progressively out-of-the-money (cheaper first); the Jev
  // pick decides between placements.
  for (const offset of side === 1 ? [0, -1, -2, 1, 2] : [0, 1, 2, -1, -2]) {
    const strike = atm + offset * step;
    const row = byStrike.get(strike);
    if (!row) continue;
    // Liquidity gate (P0-S2): dust strikes with no OI/volume or a wide spread
    // are never offered as candidates, whatever the premium looks like.
    if (!(Number.isFinite(row[4]) && row[4] >= LIQUIDITY_MIN_OI)) continue;
    if (!(Number.isFinite(row[6]) && row[6] >= LIQUIDITY_MIN_VOLUME)) continue;
    if (Number.isFinite(row[10]) && Number.isFinite(row[11]) && row[10] > 0 && row[11] > 0) {
      const mid = (row[10] + row[11]) / 2;
      if (mid > 0 && ((row[11] - row[10]) / mid) * 100 > LIQUIDITY_MAX_SPREAD_PCT) continue;
    }
    const oiChangePct = Number.isFinite(row[5]) && row[5] > 0 ? ((row[4] - row[5]) / row[5]) * 100 : null;
    const premiumChangePct = Number.isFinite(row[3]) && row[3] > 0 ? ((row[2] - row[3]) / row[3]) * 100 : null;
    const itm = side === 0 ? strike < spot : strike > spot;
    const otm = side === 0 ? strike > spot : strike < spot;
    candidates.push({
      id: `c${candidates.length + 1}`,
      strike, side, ltp: row[2], prevClose: row[3], premiumChangePct, oi: row[4], prevOi: row[5], oiChangePct,
      delta: Number.isFinite(row[17]) ? row[17] : null,
      placement: itm ? 'in-the-money — moves faster, costs more' : otm ? 'out-of-the-money — cheaper, needs a bigger move' : 'at-the-money — the default pick',
    });
    if (candidates.length === 3) break;
  }
  return candidates;
}

const NEXT_EXPIRY_DTE = Number(process.env.ADVISOR_NEXT_EXPIRY_DTE) || 3;

/**
 * Chain selection at card build: when the near expiry is inside
 * ADVISOR_NEXT_EXPIRY_DTE days and the market file carries the next-expiry
 * block, build the card on the December block instead. Rationale: the near
 * weekly bleeds ~5–8%/day inside 3 DTE; the monthly decays ~1–1.5%/day.
 */
export function chooseChain(series, now = Date.now()) {
  const next = series?.next;
  if (!next || typeof next.e !== 'string' || typeof series?.e !== 'string') return series;
  const expiryAt = Date.parse(`${series.e}T15:30:00+05:30`);
  if (!Number.isFinite(expiryAt)) return series;
  const dte = (expiryAt - now) / (24 * 60 * 60_000);
  if (dte > NEXT_EXPIRY_DTE) return series;
  return { ...series, e: next.e, sp: next.sp, pc: next.pc, atm: next.atm, r: next.r, t: next.t ?? series.t, tp: next.tp ?? series.tp };
}

/** Heaviest CE above spot (resistance) and PE below spot (support). */
export function chainWalls(series) {
  const spot = series?.sp;
  if (!Number.isFinite(spot)) return {};
  let resistance = null, support = null;
  for (const row of chainRows(series)) {
    if (!(Number.isFinite(row[4]) && row[4] > 0)) continue;
    if (row[1] === 0 && row[0] >= spot && (!resistance || row[4] > resistance.oi)) resistance = { strike: row[0], oi: row[4], changePct: Number.isFinite(row[5]) && row[5] > 0 ? round2(((row[4] - row[5]) / row[5]) * 100) : null };
    if (row[1] === 1 && row[0] <= spot && (!support || row[4] > support.oi)) support = { strike: row[0], oi: row[4], changePct: Number.isFinite(row[5]) && row[5] > 0 ? round2(((row[4] - row[5]) / row[5]) * 100) : null };
  }
  return { support, resistance };
}

function gammaCandidateData(series, candidates, bias, walls, now) {
  const enabled = new Set(parseGammaSymbols(process.env.GAMMA_SYMBOLS));
  if (!enabled.has(series?.s)) {
    return candidates.map(candidate => ({ ...candidate, gammaEnabled: false, gexAtStrike: null, distanceToFlip: null, regime: null, flipLevel: null, maxGammaStrike: null, gammaPin: null, pinNote: null, stopNote: null }));
  }

  const profile = gammaProfile(series, { lot: series?.lot ?? 1, r: gammaRiskFreeRate(process.env.GAMMA_RISK_FREE) });
  const maximum = profile.strikes.reduce((best, row) => !best || row.gamma > best.gamma ? row : best, null);
  const capturedAt = Number.isFinite(series?.t) ? series.t : now;
  const expiryAt = typeof series?.e === 'string' ? Date.parse(`${series.e}T15:30:00+05:30`) : Number.NaN;
  const daysToExpiry = Number.isFinite(expiryAt) ? (expiryAt - capturedAt) / (24 * 60 * MINUTE) : null;
  const wallStop = bias === 'bullish' ? walls?.support?.strike : walls?.resistance?.strike;
  const stopBeyondFlip = Number.isFinite(wallStop) && profile.flipLevel != null
    && (bias === 'bullish' ? wallStop < profile.flipLevel : wallStop > profile.flipLevel);
  const stopNote = stopBeyondFlip ? 'Wall-based stop sits beyond the gamma flip; dealers may accelerate the move.' : null;

  return candidates.map(candidate => {
    const side = candidate.side === 0 ? 'CE' : 'PE';
    const atStrike = profile.strikes.find(row => row.K === candidate.strike && row.side === side);
    const distanceToFlip = profile.flipLevel != null && profile.flipLevel > 0 && Number.isFinite(series?.sp)
      ? round2(((series.sp - profile.flipLevel) / profile.flipLevel) * 100)
      : null;
    const nearMaximum = maximum != null && maximum.K > 0 && Math.abs(candidate.strike - maximum.K) / maximum.K <= 0.003;
    const gammaPin = daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry <= 2 && nearMaximum
      ? `${candidate.strike}${side}`
      : null;
    const pinNote = gammaPin ? `Gamma pin zone: within 0.3% of max-gamma strike ${gammaPin} with 2 DTE or less.` : null;
    return {
      ...candidate,
      gammaEnabled: true,
      gexAtStrike: atStrike?.gex ?? null,
      distanceToFlip,
      regime: profile.regime,
      flipLevel: profile.flipLevel,
      maxGammaStrike: maximum?.K ?? null,
      gammaPin,
      pinNote,
      stopNote,
    };
  });
}

/** The card's numbers — all computed here, never by the model. */
export function levelsFor(candidate, walls) {
  return {
    entry: round2(candidate.ltp),
    sl: round2(candidate.ltp * (1 - STOP_FRACTION)),
    tgt1: round2(candidate.ltp * (1 + TGT1_FRACTION)),
    tgt2: round2(candidate.ltp * (1 + TGT2_FRACTION)),
    tsl: 'after TGT1, trail the stop to entry (cost)',
    support: walls.support ?? null,
    resistance: walls.resistance ?? null,
  };
}

/** Question wording for the advisor pass — kept beside the watchlist battery's spirit: one judgment per question. */
export function advisorQuestions(symbol, bias, candidates) {
  const side = bias === 'bearish' ? 'PE' : 'CE';
  const questions = {
    [`quality_${symbol}`]: {
      type: 'noul',
      instructions: { question: `Do the ${side} premiums and open interest both confirm a ${bias} setup on \`${symbol}\` right now?`, compare: [`\`chain.${symbol}.spot_change_pct\``, `\`chain.${symbol}.candidates\``] },
      criteria: { true: `The underlying has moved ${bias === 'bearish' ? 'down' : 'up'} today and the near-the-money ${side} premiums show it (positive premium change for ${bias === 'bearish' ? 'PE' : 'CE'}) while that side's OI builds.`, false: 'Premiums disagree with the underlying move (for example decay after the move already happened), or OI does not join, or the moves are noise-level.' },
    },
    [`strike_${symbol}`]: {
      type: 'choice',
      instructions: { question: `Which candidate ${side} strike fits a short-horizon momentum trade on \`${symbol}\` best right now?`, compare: ['the listed candidates', `\`chain.${symbol}\``] },
      criteria: Object.fromEntries(candidates.map(c => [c.id, { strike: c.strike, side, premium: c.ltp, premium_change_pct: c.premiumChangePct == null ? 'unknown' : `${c.premiumChangePct >= 0 ? '+' : ''}${c.premiumChangePct.toFixed(0)}%`, oi_change_pct: c.oiChangePct == null ? 'unknown' : `${c.oiChangePct >= 0 ? '+' : ''}${c.oiChangePct.toFixed(0)}%`, placement: c.placement }])),
    },
  };
  return questions;
}

/** The advisor's decision table — pure. */
export function advisorDecisions(watches, answers, { qualityYes = QUALITY_YES, pickMin = PICK_MIN } = {}) {
  const cards = [];
  const skipped = [];
  for (const watch of watches) {
    const symbol = watch.symbol;
    const quality = answers?.[`quality_${symbol}`]?.noul;
    const pick = answers?.[`strike_${symbol}`];
    const candidates = watch.candidates ?? [];
    const chosen = candidates.find(c => c.id === pick?.choice);
    if (!(quality >= qualityYes) || !chosen || (pick?.probabilities?.[pick.choice] ?? 0) < pickMin) {
      skipped.push({ symbol, reason: !(quality >= qualityYes) ? `quality ${quality}` : 'strike pick not decisive' });
      continue;
    }
    if (!(chosen.ltp > MIN_ENTRY_PREMIUM)) { skipped.push({ symbol, reason: 'premium too thin' }); continue; }
    const walls = watch.walls ?? {};
    cards.push({
      id: `${symbol}|${watch.date ?? `at-${watch.at ?? 0}`}`,
      at: watch.at ?? Date.now(),
      date: watch.date,
      symbol,
      spot: watch.spot ?? null,
      spotChangePct: watch.spotChangePct ?? null,
      bias: watch.bias,
      side: chosen.side === 1 ? 'PE' : 'CE',
      strike: chosen.strike,
      expiry: watch.expiry ?? null,
      ...levelsFor(chosen, walls),
      gamma: chosen.gammaEnabled ? {
        gexAtStrike: chosen.gexAtStrike ?? null,
        distanceToFlip: chosen.distanceToFlip ?? null,
        regime: chosen.regime ?? null,
        flipLevel: chosen.flipLevel ?? null,
        pin: chosen.gammaPin ?? null,
        notes: [chosen.pinNote, chosen.stopNote].filter(Boolean),
      } : null,
      quality,
      strikePickProbability: pick.probabilities[pick.choice],
      oiChangePct: chosen.oiChangePct,
      delta: Number.isFinite(chosen.delta) ? chosen.delta : null,
      atr: null,
      disclaimer: DISCLAIMER,
    });
  }
  return { cards, skipped };
}

/**
 * Early-signal cards, computed by code (no model gate). The owner wants early
 * grabs at the bottom, not only model-confirmed setups, so a fast price move
 * still scores a card when either (a) chain OI is adding strongly (build-up)
 * or (b) OI is flat/falling (momentum / short covering — the model gate was
 * skipping exactly these). Cap: two early cards per pass, one per symbol/day.
 */
export function earlyCards(market, date, now, existing = [], { max = 2 } = {}) {
  if (!market || typeof date !== 'string') return [];
  const seen = new Set((Array.isArray(existing) ? existing : []).map(card => observationKey(card)).filter(Boolean));
  const out = [];
  for (const mover of marketMovers(market)) {
    if (out.length >= max) break;
    if (!Number.isFinite(mover.changePct) || Math.abs(mover.changePct) < 1.5) continue;
    const oiPct = Number.isFinite(mover.oiPct) ? mover.oiPct : 0;
    const strong = oiPct >= 5;
    const momentum = Math.abs(oiPct) < 2;
    if (!strong && !momentum) continue;
    const key = `${mover.symbol}|${date}`;
    if (seen.has(key)) continue;
    const series = (market.series ?? []).find(item => item?.s === mover.symbol);
    const chain = chooseChain(series, now);
    if (!chain) continue;
    const bias = mover.changePct > 0 ? 'bullish' : 'bearish';
    const candidate = candidateStrikes(chain, bias)[0];
    if (!candidate || !(candidate.ltp > MIN_ENTRY_PREMIUM)) continue;
    seen.add(key);
    out.push({
      id: key,
      at: now,
      date,
      symbol: mover.symbol,
      spot: Number.isFinite(chain.sp) ? chain.sp : mover.spot ?? null,
      spotChangePct: Number.isFinite(mover.changePct) ? round2(mover.changePct) : null,
      bias,
      side: candidate.side === 0 ? 'CE' : 'PE',
      strike: candidate.strike,
      expiry: chain.e ?? null,
      ...levelsFor(candidate, chainWalls(chain)),
      quality: null,
      strikePickProbability: null,
      oiChangePct: candidate.oiChangePct,
      delta: candidate.delta ?? null,
      early: strong ? 'build-fast' : 'momentum',
      atr: null,
      disclaimer: DISCLAIMER,
    });
  }
  return out;
}

export function observationKey(card) {
  if (typeof card?.symbol === 'string' && typeof card?.date === 'string') return `${card.symbol}|${card.date}`;
  return typeof card?.id === 'string' && card.id.length ? `id:${card.id}` : null;
}

export function dedupeObservations(cards) {
  const seen = new Set();
  return cards.filter((card, index) => {
    const key = observationKey(card) ?? `unkeyed:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keep every unresolved card; resolved history is evicted oldest-first. */
export function retainObservations(cards, maxCards = MAX_CARDS) {
  const unique = dedupeObservations(Array.isArray(cards) ? cards : []);
  const limit = Number.isSafeInteger(maxCards) && maxCards >= 0 ? maxCards : MAX_CARDS;
  if (unique.length <= limit) return unique;
  const unresolved = unique.filter(card => !card?.outcome || typeof card.outcome !== 'object');
  const resolved = unique.filter(card => card?.outcome && typeof card.outcome === 'object');
  const resolvedToKeep = Math.max(0, limit - unresolved.length);
  const keptResolved = new Set(resolved.slice(0, resolvedToKeep));
  return unique.filter(card => !card?.outcome || typeof card.outcome !== 'object' || keptResolved.has(card));
}

/** Read + normalise the observations store. */
export function loadObservations(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.cards) ? dedupeObservations(parsed.cards) : [];
  } catch { return []; }
}

function saveObservations(path, cards) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ cards }, null, 2));
  renameSync(tmp, path);
}

const notified = new Set(); // `symbol|sessionDate` — one Telegram note per card per day

function futuresAtr(snapshot, symbol, sessionDate, now) {
  if (typeof symbol !== 'string' || typeof sessionDate !== 'string' || !snapshot || snapshot.symbol !== symbol || snapshot.session !== sessionDate || !Array.isArray(snapshot.months)) return null;
  const month = snapshot.months
    .filter(item => item && typeof item === 'object' && typeof item.date === 'string' && Array.isArray(item.candles))
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  if (!month) return null;
  const candles = month.candles.filter(candle => candle && Number.isFinite(candle.at) && candle.at + MINUTE <= now);
  const summary = atrSummary(candles, { period: 14, barMinutes: 15 });
  if (!summary || !Number.isFinite(summary.atr) || !['compressed', 'normal', 'expanded'].includes(summary.state)) return null;
  return { value: summary.atr, barMinutes: 15, state: summary.state };
}

/**
 * Owner's ORB playbook, checked against the card at build time: the 09:15–09:20
 * opening range from today's futures candles, breakout beyond it on the bias
 * side, chain OI ≥ 5% confirming participation, and the 4% extended-opener
 * rule (wait for a VWAP touch instead of chasing).
 */
export function orbStrategy(snapshot, card, now) {
  if (!snapshot || !Array.isArray(snapshot.months)) return null;
  const month = snapshot.months[0];
  const candles = Array.isArray(month?.candles) ? month.candles : [];
  const openAt = Date.parse(`${snapshot.session}T09:15:00+05:30`);
  const rangeCandles = candles.filter(candle => Number.isFinite(candle?.at) && candle.at >= openAt && candle.at < openAt + 5 * 60_000);
  if (rangeCandles.length < 3) return { qualifies: false, label: 'Strategy: ORB — opening range pending (need the 09:20 candle)' };
  const high = Math.max(...rangeCandles.map(candle => Number.isFinite(candle.high) ? candle.high : candle.close));
  const low = Math.min(...rangeCandles.map(candle => Number.isFinite(candle.low) ? candle.low : candle.close));
  const px = value => Number(value.toFixed(2));
  const signedPct = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
  const spot = Number.isFinite(card?.spot) ? card.spot : null;
  if (!spot) return { qualifies: false, label: `Strategy: ORB — range ${px(low)}–${px(high)}, spot unavailable` };
  const bullish = card.bias !== 'bearish';
  const level = bullish ? high : low;
  const broke = bullish ? spot > level : spot < level;
  const extendedPct = bullish ? (spot - high) / high * 100 : (low - spot) / low * 100;
  const oiPct = Number.isFinite(card?.oiChangePct) ? card.oiChangePct : null;
  if (extendedPct >= 4) {
    return { qualifies: false, label: `Strategy: ORB ⏳ — extended +${extendedPct.toFixed(1)}% opener — wait for a VWAP touch` };
  }
  if (!broke) {
    return { qualifies: false, label: `Strategy: ORB ✗ — no breakout yet (range ${px(low)}–${px(high)})` };
  }
  if (oiPct == null || oiPct < 5) {
    return { qualifies: false, label: `Strategy: ORB ✗ — broke ${px(level)} but OI ${oiPct == null ? 'unknown' : signedPct(oiPct)} (<5% needed)` };
  }
  return { qualifies: true, label: `Strategy: ORB ✓ — broke ${px(level)} · OI ${signedPct(oiPct)} · SL zone ${px(bullish ? low : high)}` };
}

/**
 * ATR/delta-aware premium levels (P0-S2): with the underlying's 15-min ATR and
 * the strike's captured delta, one bar's premium move ≈ ATR × |delta|; the stop
 * sits one such move away and targets 1.5× / 2.5× it. Falls back to the fixed
 * premium fractions (levelsBasis 'fixed') when either number is unavailable.
 */
export function adaptiveLevels(card) {
  const atr = card?.atr?.value;
  const delta = card?.delta;
  const entry = card?.entry;
  if (!(Number.isFinite(atr) && atr > 0 && Number.isFinite(delta) && Math.abs(delta) > 0 && Number.isFinite(entry) && entry > 0)) {
    return { ...card, levelsBasis: 'fixed' };
  }
  const move = Math.max(atr * Math.abs(delta), entry * 0.08);
  return {
    ...card,
    sl: round2(Math.max(entry * 0.5, entry - ATR_STOP_MULT * move)),
    tgt1: round2(entry + ATR_TGT1_MULT * move),
    tgt2: round2(entry + ATR_TGT2_MULT * move),
    levelsBasis: 'ATR',
  };
}

async function enrichWithFuturesAtr(cards, { readFuturesSnapshot, sessionDate, now, log }) {
  if (typeof readFuturesSnapshot !== 'function') return cards;
  return Promise.all(cards.map(async card => {
    try {
      const snapshot = await readFuturesSnapshot(card.symbol, sessionDate);
      return adaptiveLevels({ ...card, atr: futuresAtr(snapshot, card.symbol, sessionDate, now), strategy: orbStrategy(snapshot, card, now) });
    } catch (error) {
      log(`advisor ATR unavailable for ${card.symbol}: ${String(error?.message || error)}`);
      return card;
    }
  }));
}

/**
 * One advisor pass over the triage's watch list. Never throws; every failure
 * is logged and the observations file keeps its previous content.
 */
export async function runAdvisor(market, { obsPath, watches, now = Date.now(), log = () => {}, ask = askTypeSafe, configured = typesafeConfigured, send = sendTelegramObservationCard, getLive = () => null, readFuturesSnapshot = () => null, subscriberChatIds = [], sendSubscriber = (text, chatId) => sendTelegram(text, { chatId, parseMode: 'HTML', retry: true }) } = {}) {
  const sessionDate = typeof market?.date === 'string' ? market.date : null;
  if (!configured()) return { skipped: 'not configured' };
  if (!inFireWindow(now)) return { skipped: 'outside fire window' };
  if (!Array.isArray(watches) || !watches.length) return { skipped: 'no watched symbols' };
  const seriesFor = symbol => (market?.series ?? []).find(item => item?.s === symbol) ?? null;
  const prepared = [];
  for (const watch of watches) {
    const series = chooseChain(seriesFor(watch.symbol), now);
    const candidates = candidateStrikes(series, watch.bias);
    if (!candidates.length) continue;
    const spot = Number.isFinite(series?.sp) ? series.sp : null;
    const spotChangePct = spot !== null && Number.isFinite(series?.pc) && series.pc > 0 ? round2((spot / series.pc - 1) * 100) : null;
    const walls = chainWalls(series);
    const candidatesWithGamma = gammaCandidateData(series, candidates, watch.bias, walls, now);
    prepared.push({ ...watch, at: now, date: sessionDate, expiry: series?.e ?? null, spot, spotChangePct, candidates: candidatesWithGamma, walls });
  }
  if (!prepared.length) return { skipped: 'no readable chains on watched symbols' };
  try {
    const questions = {};
    const spotOf = p => chooseChain(seriesFor(p.symbol), now) ?? {};
    const state = { chain: Object.fromEntries(prepared.map(p => {
      const s = spotOf(p);
      return [p.symbol, {
        spot: s.sp,
        spot_change_pct: Number.isFinite(s.sp) && Number.isFinite(s.pc) && s.pc > 0 ? round2(((s.sp - s.pc) / s.pc) * 100) : null,
        atm: s.atm,
        bias: p.bias,
        candidates: p.candidates.map(c => ({ strike: c.strike, side: c.side === 1 ? 'PE' : 'CE', premium: c.ltp, premium_change_pct: c.premiumChangePct == null ? null : round2(c.premiumChangePct), oi_change_pct: c.oiChangePct == null ? null : round2(c.oiChangePct), placement: c.placement, gexAtStrike: c.gexAtStrike, distanceToFlip: c.distanceToFlip, regime: c.regime })),
        walls: p.walls,
      }];
    })) };
    for (const p of prepared) Object.assign(questions, advisorQuestions(p.symbol, p.bias, p.candidates));
    const answers = await ask(state, questions);
    const decisions = advisorDecisions(prepared, answers);
    // Code-computed early grabs ride alongside the model's cards.
    const existingForDedupe = loadObservations(obsPath);
    const early = earlyCards(market, sessionDate, now, [...existingForDedupe, ...decisions.cards]);
    if (early.length) log(`advisor early signals: ${early.map(card => `${card.symbol} ${card.strike}${card.side} (${card.early})`).join(', ')}`);
    const cards = await enrichWithFuturesAtr([...decisions.cards, ...early], { readFuturesSnapshot, sessionDate, now, log });
    const { skipped } = decisions;
    if (cards.length) {
      const freshCards = dedupeObservations(cards);
      const existing = loadObservations(obsPath);
      const existingKeys = new Set(existing.map(observationKey).filter(Boolean));
      const stored = retainObservations([...freshCards, ...existing]);
      saveObservations(obsPath, stored);
      const fresh = freshCards.filter(card => {
        const key = observationKey(card);
        return key && !existingKeys.has(key) && !notified.has(key);
      });
      for (const card of freshCards) {
        const key = observationKey(card);
        if (key) notified.add(key);
      }
      for (const card of fresh) {
        let live = null;
        try { live = getLive(card); } catch { /* quiet live feeds do not block the captured-data card */ }
        const result = await send({ ...card, sentAt: now, live });
        log(`telegram ${result.sent ? 'sent' : `not sent (${result.reason ?? result.status})`}: observation ${card.symbol} ${card.strike}${card.side}`);
        // Subscribers get the same signal instantly in the stripped copy
        // (owner decision 2026-11-18: "Instant सबको भेजो") — no model words.
        if (subscriberChatIds.length) {
          const caption = observationSubscriberCaption({ ...card, sentAt: now, live });
          for (const chatId of subscriberChatIds) {
            try {
              const sub = await sendSubscriber(caption, chatId);
              if (!sub?.sent) log(`telegram subscriber card ${chatId} not sent (${sub?.reason ?? sub?.status ?? 'unknown'})`);
            } catch (error) {
              log(`telegram subscriber card ${chatId} failed: ${String(error?.message || error)}`);
            }
          }
        }
      }
    }
    for (const s of skipped) log(`advisor skipped ${s.symbol}: ${s.reason}`);
    return { written: cards.length, cards };
  } catch (error) {
    log(`advisor failed (observations unchanged): ${String(error?.message || error)}`);
    return { skipped: 'failed', error: String(error?.message || error) };
  }
}
