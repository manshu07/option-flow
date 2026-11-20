import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sendTelegram, sendTelegramObservationCard } from './telegram.mjs';
import { observationSubscriberCaption } from './observationCardSvg.mjs';
import { askTypeSafe, typesafeConfigured } from './typesafe.mjs';
import { inFireWindow, marketMovers } from './alerts.mjs';
import { gammaProfile, gammaRiskFreeRate, parseGammaSymbols } from '../src/features/market-flow/gammaModel.ts';
import { atrSummary } from '../src/features/market-flow/atrModel.ts';
import { openingRange, sessionVwap } from './orbModel.mjs';
import { greeks, optionIv, premiumAtLevel, spotForPremium, levelFor, yearsToExpiry } from './optionMath.mjs';
import { loadMoveStats, moveFor, reachRate } from './moveStats.mjs';
import { loadLevelGrid, cellFor, pickPairForStrike } from './levelPolicy.mjs';
import { liveRegime } from './moveRegime.mjs';
import { scoreStrikes } from './strikeChoice.mjs';

const MOVE_STATS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data', 'move-stats');
const LEVEL_GRID_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data', 'level-grid');
const IST_OFFSET = 19_800_000;
const hhmmIst = at => { const d = new Date(at + IST_OFFSET); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

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
/** Option premiums trade on a ₹0.05 tick — computed levels snap to the grid
 *  so a card never quotes a price the tape cannot print (5.37 → 5.35). */
const snapTick = value => Math.round(value * 20) / 20;
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
// The owner reads the whole history, not just the last fifty: the store keeps
// a large tail (env-tunable) and never evicts an unresolved card.
const MAX_CARDS = Number(process.env.OBS_MAX_CARDS) || 2000;

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
      iv: Number.isFinite(row[9]) && row[9] > 0 ? row[9] : null,
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
 * Also falls back to the next expiry outside that window when the near chain
 * offers no liquid candidate at all (dust OI/volume or wide spreads) but the
 * next one does — otherwise a tradeable monthly sits unused (AMBUJACEM).
 */
export function chooseChain(series, now = Date.now()) {
  const next = series?.next;
  if (!next || typeof next.e !== 'string' || typeof series?.e !== 'string') return series;
  const expiryAt = Date.parse(`${series.e}T15:30:00+05:30`);
  if (!Number.isFinite(expiryAt)) return series;
  const merged = { ...series, e: next.e, sp: next.sp, pc: next.pc, atm: next.atm, r: next.r, t: next.t ?? series.t, tp: next.tp ?? series.tp };
  const dte = (expiryAt - now) / (24 * 60 * 60_000);
  if (dte <= NEXT_EXPIRY_DTE) return merged;
  const hasCandidate = chain => candidateStrikes(chain, 'bullish').length > 0 || candidateStrikes(chain, 'bearish').length > 0;
  if (hasCandidate(series) || !hasCandidate(merged)) return series;
  return merged;
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
    sl: snapTick(candidate.ltp * (1 - STOP_FRACTION)),
    tgt1: snapTick(candidate.ltp * (1 + TGT1_FRACTION)),
    tgt2: snapTick(candidate.ltp * (1 + TGT2_FRACTION)),
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
      criteria: { true: `The underlying has moved ${bias === 'bearish' ? 'down' : 'up'} today and the near-the-money ${side} premiums show it (positive premium change for ${bias === 'bearish' ? 'PE' : 'CE'}) while that side's OI builds. Confidence anchors: 90%+ = clean build-up, walls aligned, liquid strike; 65–89% = setup holds but one leg is weak; 40–64% = mixed; below 30% = noise. Answer with that confidence, not a bare yes.`, false: 'Premiums disagree with the underlying move (for example decay after the move already happened), or OI does not join, or the moves are noise-level.' },
    },
    [`strike_${symbol}`]: {
      type: 'choice',
      instructions: { question: `Which candidate ${side} strike fits a short-horizon momentum trade on \`${symbol}\` best right now?`, compare: ['the listed candidates', `\`chain.${symbol}\``] },
      criteria: Object.fromEntries(candidates.map(c => [c.id, { strike: c.strike, side, premium: c.ltp, premium_change_pct: c.premiumChangePct == null ? 'unknown' : `${c.premiumChangePct >= 0 ? '+' : ''}${c.premiumChangePct.toFixed(0)}%`, oi_change_pct: c.oiChangePct == null ? 'unknown' : `${c.oiChangePct >= 0 ? '+' : ''}${c.oiChangePct.toFixed(0)}%`, placement: c.placement }])),
    },
  };
  return questions;
}

/**
 * Quality arrives on either a 0–1 probability scale or an explicit 0–100
 * strength score (P0-S3). ADVISOR_QUALITY_SCALE=1 pins 0–1, =100 pins 0–100,
 * unset auto-detects (>1 means the model answered 0–100). Always returns 0–1.
 */
export function normalizeQuality(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const pin = Number(process.env.ADVISOR_QUALITY_SCALE) || 0;
  const scaled = pin === 1 ? value : pin === 100 ? value / 100 : value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, scaled));
}

/** The advisor's decision table — pure. */
export function advisorDecisions(watches, answers, { qualityYes = QUALITY_YES, pickMin = PICK_MIN } = {}) {
  const cards = [];
  const skipped = [];
  for (const watch of watches) {
    const symbol = watch.symbol;
    const quality = normalizeQuality(answers?.[`quality_${symbol}`]?.noul);
    const pick = answers?.[`strike_${symbol}`];
    const candidates = watch.candidates ?? [];
    const chosen = candidates.find(c => c.id === pick?.choice);
    if (!(quality >= qualityYes) || !chosen || (pick?.probabilities?.[pick.choice] ?? 0) < pickMin) {
      skipped.push({ symbol, reason: !(quality >= qualityYes) ? `quality ${quality == null ? 'unknown' : `${Math.round(quality * 100)}%`}` : 'strike pick not decisive' });
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
      iv: Number.isFinite(chosen.iv) ? chosen.iv : null,
      atr: null,
      disclaimer: DISCLAIMER,
    });
  }
  return { cards, skipped };
}

/**
 * The owner's actionable-card gate: a level pair must exist (not no-edge) and
 * its measured premium expectancy must not be negative. Shared by the early
 * path (so a rejected candidate never consumes a cap slot) and runAdvisor.
 */
function acceptCheck(card, minExpectancy) {
  if (card?.levelsBasis === 'no-edge') return { ok: false, reason: card.levelsRejected ?? 'no achievable pair' };
  const exp = card?.backtest?.expectancyPremium;
  if (Number.isFinite(exp) && exp < minExpectancy) return { ok: false, reason: `negative expectancy ₹${exp} over ${card.backtest.samples} past windows` };
  return { ok: true };
}

/**
 * Early-signal cards, computed by code (no model gate). The owner wants early
 * grabs at the bottom, not only model-confirmed setups, so a fast price move
 * still scores a card when either (a) chain OI is adding strongly (build-up)
 * or (b) OI is flat OR unwinding (momentum — short covering on a rally and
 * long unwinding on a fall both ride here; only a mild fresh build-up of 2–5%
 * waits for confirmation). Each candidate is priced and gated BEFORE it counts
 * toward the cap, so a permanently-rejectable name cannot starve real setups.
 * Momentum candidates additionally must not oppose the symbol's or the index's
 * 15-minute futures slope (trendFor lookup), must wait out the opening chop,
 * and need the option premium itself confirming the move (not flat, not a
 * late chase) — counter-trend/premature/late momentum was the 2026-11-19 SL
 * cluster. Cap: two early cards per pass, one per symbol/day.
 */
export function earlyCards(market, date, now, existing = [], { max = 2, minExpectancy = Number(process.env.ADVISOR_MIN_EXPECTANCY ?? 0), priceCard, trendFor, log = () => {} } = {}) {
  if (!market || typeof date !== 'string') return [];
  const price = priceCard ?? (card => adaptiveLevels(card, { now, moveStats: loadMoveStats(MOVE_STATS_DIR, card.symbol), levelGrid: loadLevelGrid(LEVEL_GRID_DIR, card.symbol) }));
  const trendGateMin = Number(process.env.MOMENTUM_TREND_GATE_PCT) || 0.1;
  // Opening chop: the first minutes after 09:15 produced the 09:40-10:34 SL
  // cluster — momentum waits MOMENTUM_SKIP_OPEN_MIN minutes (default 15).
  const skipOpenMin = Number(process.env.MOMENTUM_SKIP_OPEN_MIN) || 15;
  const openTotal = 9 * 60 + 15 + skipOpenMin;
  const openCutoff = `${String(Math.floor(openTotal / 60)).padStart(2, '0')}:${String(openTotal % 60).padStart(2, '0')}`;
  const seen = new Set((Array.isArray(existing) ? existing : []).map(card => observationKey(card)).filter(Boolean));
  const out = [];
  for (const mover of marketMovers(market)) {
    if (out.length >= max) break;
    if (!Number.isFinite(mover.changePct) || Math.abs(mover.changePct) < 1.5) continue;
    const oiPct = Number.isFinite(mover.oiPct) ? mover.oiPct : 0;
    const strong = oiPct >= 5;
    const momentum = oiPct < 2;
    if (!strong && !momentum) continue;
    const bias = mover.changePct > 0 ? 'bullish' : 'bearish';
    // Momentum entries die to the opening whipsaw when they run against the
    // live trend — the 2026-11-19 SL cluster (4/12 counter-trend, 5 more
    // index-against). A momentum card must not oppose the symbol's or the
    // index's 15-minute futures slope; build-fast keeps its OI confirmation
    // and skips this gate. Unknown trend (sparse candles) passes — data
    // availability first.
    if (momentum && trendFor) {
      const against = tr => tr != null && (bias === 'bullish' ? tr <= -trendGateMin : tr >= trendGateMin);
      const symTr = trendFor(mover.symbol, now);
      const idxTr = trendFor('NIFTY', now);
      if (against(symTr) || against(idxTr)) {
        log(`advisor momentum trend-gate: ${mover.symbol} ${bias} sym ${symTr ?? '?'}% nifty ${idxTr ?? '?'}% — skipped`);
        continue;
      }
    }
    const key = `${mover.symbol}|${date}`;
    if (seen.has(key)) continue;
    const series = (market.series ?? []).find(item => item?.s === mover.symbol);
    const chain = chooseChain(series, now);
    if (!chain) continue;
    const candidate = candidateStrikes(chain, bias)[0];
    if (!candidate || !(candidate.ltp > MIN_ENTRY_PREMIUM)) continue;
    // Momentum needs the premium itself to confirm: a premium that barely
    // moved while the spot ran is a divergence, and one that already ran
    // >25% is a late chase. Plus the opening-chop window above. build-fast
    // (OI-confirmed) stays exempt from all three.
    if (momentum) {
      const pchg = candidate.premiumChangePct;
      const premiumMin = Number(process.env.MOMENTUM_PREMIUM_MIN_PCT) || 5;
      const premiumMax = Number(process.env.MOMENTUM_PREMIUM_MAX_PCT) || 25;
      if (hhmmIst(now) < openCutoff) {
        log(`advisor momentum open-chop gate: ${mover.symbol} at ${hhmmIst(now)} < ${openCutoff} IST — skipped`);
        continue;
      }
      if (pchg != null && (pchg < premiumMin || pchg > premiumMax)) {
        log(`advisor momentum premium-gate: ${mover.symbol} premium ${pchg.toFixed(1)}% (need ${premiumMin}..${premiumMax}%) — skipped`);
        continue;
      }
    }
    const card = {
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
      iv: candidate.iv ?? null,
      early: strong ? 'build-fast' : 'momentum',
      atr: null,
      disclaimer: DISCLAIMER,
    };
    // Gate before counting the slot: a no-edge / negative-expectancy candidate
    // is dropped here and the next mover gets its chance (MOTILALOFS starvation).
    if (!acceptCheck(price(card), minExpectancy).ok) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

export function observationKey(card) {
  const suffix = card?.reEntry ? `:re${card.reEntry}` : '';
  if (typeof card?.symbol === 'string' && typeof card?.date === 'string') return `${card.symbol}|${card.date}${suffix}`;
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
const upgradeNotified = new Set(); // `symbol|sessionDate` — one upgrade note per card per day
// Intraday SL-hit marks for the re-entry trigger: a pass that sees a card's
// live premium at/below its stop records it here; a later pass that sees the
// contract recovered back to entry fires the RE-ENTRY card (owner rule).
const slHitLive = new Set();
let slHitSession = null;

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
  // Same range rule as the ORB scanner: Dhan prints no candle in a minute with
  // no trades, so a stock future often has 1–3 prints inside 09:15–09:20. A
  // three-minute range is still the opening range — the old "need the 09:20
  // candle" gate hid the tag on 200 of 228 symbols.
  const range = openingRange(candles, snapshot.session, { now });
  if (!range) return { qualifies: false, label: 'Strategy: ORB — opening range pending (no 09:15–09:20 candle captured yet)' };
  const vwap = sessionVwap(candles, snapshot.session, { until: now });
  const px = value => Number(value.toFixed(2));
  const signedPct = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
  const spot = Number.isFinite(card?.spot) ? card.spot : null;
  if (!spot) return { qualifies: false, label: `Strategy: ORB — range ${px(range.low)}–${px(range.high)} (${range.candles} min), spot unavailable` };
  const bullish = card.bias !== 'bearish';
  const level = bullish ? range.high : range.low;
  const broke = bullish ? spot > level : spot < level;
  const extendedPct = bullish ? (spot - range.high) / range.high * 100 : (range.low - spot) / range.low * 100;
  const oiPct = Number.isFinite(card?.oiChangePct) ? card.oiChangePct : null;
  const minutes = ` (${range.candles} min)`;
  if (extendedPct >= 4) {
    return { qualifies: false, label: `Strategy: ORB ⏳ — extended +${extendedPct.toFixed(1)}% opener — wait for a VWAP touch${vwap == null ? '' : ` near ${px(vwap)}`}` };
  }
  if (!broke) {
    return { qualifies: false, label: `Strategy: ORB ✗ — no breakout yet (range ${px(range.low)}–${px(range.high)}${minutes})` };
  }
  if (oiPct == null || oiPct < 5) {
    return { qualifies: false, label: `Strategy: ORB ✗ — broke ${px(level)} but OI ${oiPct == null ? 'unknown' : signedPct(oiPct)} (<5% needed)` };
  }
  return { qualifies: true, label: `Strategy: ORB ✓ — broke ${px(level)} · OI ${signedPct(oiPct)} · SL zone ${px(bullish ? range.low : range.high)}` };
}

/**
 * ATR/delta-aware premium levels (P0-S2): with the underlying's 15-min ATR and
 * the strike's captured delta, one bar's premium move ≈ ATR × |delta|; the stop
 * sits one such move away and targets 1.5× / 2.5× it. Falls back to the fixed
 * premium fractions (levelsBasis 'fixed') when either number is unavailable.
 */
export function adaptiveLevels(card, opts = {}) {
  const priced = computeAdaptiveLevels(card, opts);
  return {
    ...priced,
    sl: Number.isFinite(priced.sl) ? snapTick(priced.sl) : priced.sl,
    tgt1: Number.isFinite(priced.tgt1) ? snapTick(priced.tgt1) : priced.tgt1,
    tgt2: Number.isFinite(priced.tgt2) ? snapTick(priced.tgt2) : priced.tgt2,
  };
}

function computeAdaptiveLevels(card, { holdDays = Number(process.env.ADVISOR_HOLD_DAYS) || 2, now = Date.now(), moveStats = null, levelGrid = null, policy = process.env.ADVISOR_LEVEL_POLICY || 'achievable' } = {}) {
  const atr = card?.atr?.value;
  const entry = card?.entry;
  // Only the premium is mandatory. History and the path backtest size levels
  // from the STOCK's own distribution and need no ATR at all — gating on ATR
  // first sent every "futures warming up" card back to the old fixed ±45/55%.
  if (!(Number.isFinite(entry) && entry > 0)) return { ...card, levelsBasis: 'fixed' };
  const spot = card?.spot;
  const years = yearsToExpiry(card?.expiry, now);
  const iv = years && spot > 0 ? optionIv({ premium: entry, spot, strike: card.strike, years, side: card.side, captured: card.iv }) : null;
  const g = iv ? greeks({ spot, strike: card.strike, years, iv, side: card.side }) : null;
  // Captured delta wins when the feed has it; December legs often carry none,
  // and the priced delta is the same number the chain would report.
  const delta = Number.isFinite(card?.delta) && Math.abs(card.delta) > 0 ? card.delta : g?.delta ?? null;

  // No greeks and no captured delta: the ATR approximation, honestly labelled.
  if (!g || !(Number.isFinite(delta) && Math.abs(delta) > 0)) {
    if (!(Number.isFinite(atr) && atr > 0) || !(Number.isFinite(delta) && Math.abs(delta) > 0)) return { ...card, levelsBasis: 'fixed' };
    const move = Math.max(atr * Math.abs(delta), entry * 0.08);
    return {
      ...card,
      sl: round2(Math.max(entry * 0.5, entry - ATR_STOP_MULT * move)),
      tgt1: round2(entry + ATR_TGT1_MULT * move),
      tgt2: round2(entry + ATR_TGT2_MULT * move),
      levelsBasis: 'ATR',
    };
  }

  // Levels are sized on the UNDERLYING (ATR multiples), then converted to a
  // premium with gamma and the decay of the intended hold. The stock price each
  // level needs travels with the card, so a target is never a bare percentage.
  const days = Math.max(1, Math.min(holdDays, Math.floor(years * 365)));
  // Preferred basis: what THIS stock has actually done over the same hold,
  // from the owner's equity history (spot — the option's own underlying).
  // p30 is the move 70% of past windows reached; the stop sits at the adverse
  // p85, which only 15% of windows exceeded.
  const hhmm = hhmmIst(Number.isFinite(card?.at) ? card.at : now);
  const histTarget = moveStats ? moveFor({ stats: moveStats, hhmm, holdDays: days, side: card.side, percentile: 30 }) : null;
  const histStretch = moveStats ? moveFor({ stats: moveStats, hhmm, holdDays: days, side: card.side, percentile: 70 }) : null;
  const histAdverse = moveStats ? moveFor({ stats: moveStats, hhmm, holdDays: days, side: card.side === 'PE' ? 'CE' : 'PE', percentile: 85 }) : null;
  const useHistory = Boolean(histTarget && histStretch && histAdverse && spot > 0);
  // Strongest basis: the pair whose PATH was replayed — how often the target
  // came before the stop, under the regime this stock is in right now.
  const regime = liveRegime(moveStats?.recentCloses, spot);
  const cell = cellFor({ grid: levelGrid, holdDays: days, hhmm, regime, side: card.side });
  // The wall the stock must clear first: a target beyond resistance (CE) or
  // below support (PE) is a breakout bet, not an achievable one.
  const wall = card.side === 'PE' ? card?.support?.strike : card?.resistance?.strike;
  const chosen = pickPairForStrike({ cell, spot, strike: card.strike, entry, years, iv, side: card.side, days, policy, wall });
  const pair = chosen.pair;
  const pairPriced = chosen.priced ?? null;
  const useBacktest = Boolean(pair && pairPriced);
  // Fallback: the ATR is measured on 15-minute bars; a multi-day hold needs the
  // move of that many sessions, so scale it by the square root of the bar count.
  const barMinutes = Number(card?.atr?.barMinutes) || 15;
  const barsPerSession = Math.max(1, 375 / barMinutes);
  const horizonAtr = Number.isFinite(atr) && atr > 0 ? atr * Math.sqrt(barsPerSession * days) : null;
  // Neither history nor a backtest cell, and no ATR either: nothing to size on.
  if (!useBacktest && !useHistory && horizonAtr == null) return { ...card, levelsBasis: 'fixed' };
  const priced = move => round2(Math.max(0.05, premiumAtLevel({ level: card.side === 'PE' ? spot - move : spot + move, strike: card.strike, years, iv, side: card.side, days }) ?? entry));
  const slMove = useBacktest ? spot * pair.stopPct / 100 : useHistory ? spot * histAdverse.pct / 100 : ATR_STOP_MULT * horizonAtr;
  const tgt1Move = useBacktest ? spot * pair.targetPct / 100 : useHistory ? spot * histTarget.pct / 100 : ATR_TGT1_MULT * horizonAtr;
  const tgt2Move = useBacktest ? spot * Math.min(pair.targetPct * 2, pair.targetPct + 1) / 100 : useHistory ? spot * histStretch.pct / 100 : ATR_TGT2_MULT * horizonAtr;
  const needs = {
    sl: levelFor({ spot, move: -slMove, side: card.side }),
    tgt1: levelFor({ spot, move: tgt1Move, side: card.side }),
    tgt2: levelFor({ spot, move: tgt2Move, side: card.side }),
  };
  // We have replayed history for this cell and it says no pair is both
  // achievable and payable — then there is no card, not a weaker target.
  if (cell && !useBacktest) {
    return { ...card, levelsBasis: 'no-edge', levelsRejected: chosen.reason ?? 'no achievable pair', regime, needs: null, backtest: null };
  }
  const tgt1 = priced(tgt1Move);
  // Decay can eat an ATR-sized target on a weekly leg; say so instead of
  // printing a target below the entry.
  if (!(tgt1 > entry)) {
    return { ...card, levelsBasis: 'decay-too-heavy', holdDays: days, thetaDay: round2(g.thetaDay), needs: null };
  }
  return {
    ...card,
    sl: priced(-slMove),
    tgt1,
    tgt2: priced(tgt2Move),
    levelsBasis: useBacktest ? 'backtest+decay' : useHistory ? 'history+decay' : 'ATR+decay',
    // A card sized on a multi-session move is a swing, and the journal keeps
    // grading it until this date instead of leaving it open after day one.
    horizon: days >= 1 ? 'swing' : 'intraday',
    holdTill: (() => {
      const start = Date.parse(`${card?.date ?? ''}T00:00:00+05:30`);
      if (!Number.isFinite(start)) return null;
      let left = days;
      let t = start;
      while (left > 0) {
        t += 86_400_000;
        const weekday = new Date(t + 19_800_000).getUTCDay();
        if (weekday !== 0 && weekday !== 6) left--;
      }
      return new Date(t + 19_800_000).toISOString().slice(0, 10);
    })(),
    regime,
    // What this stock's remaining session has actually delivered from this
    // time of day — the ceiling a target has to live under.
    dayReach: (() => {
      if (!moveStats?.intraday) return null;
      const times = Object.keys(moveStats.intraday).filter(t => t <= hhmm).sort();
      const bucket = times[times.length - 1];
      const set = bucket ? (moveStats.intraday[bucket]?.recent ?? moveStats.intraday[bucket]?.all) : null;
      const dir = card.side === 'PE' ? 'down' : 'up';
      const values = set?.[dir];
      if (!values) return null;
      return { bucket, side: dir, p50: values.p50, p70: values.p70, p95: values.p95, max: values.max, samples: values.n };
    })(),
    levelsRejected: useBacktest ? null : chosen.reason ?? null,
    backtest: useBacktest ? {
      policy: pair.policy,
      constrained: pair.constrained,
      scope: pair.scope,
      samples: pair.samples,
      targetPct: pair.targetPct,
      stopPct: pair.stopPct,
      winRate: pair.winRate,
      lossRate: pair.lossRate,
      openRate: pair.openRate,
      expectancyPct: pair.expectancyPct,
      premiumGain: round2(pairPriced.gain),
      premiumRisk: round2(pairPriced.risk),
      rewardRisk: pairPriced.rewardRisk == null ? null : round2(pairPriced.rewardRisk),
      wall: Number.isFinite(wall) ? wall : null,
      rejected: null,
      expectancyPremium: round2(pairPriced.expectancyPremium),
      expectancyPremiumPct: pairPriced.expectancyPct == null ? null : round2(pairPriced.expectancyPct),
    } : null,
    history: useHistory ? {
      instrument: moveStats.instrument,
      era: histTarget.era,
      holdDays: histTarget.holdDays ?? 0,
      samples: histTarget.samples,
      targetPct: histTarget.pct,
      stretchPct: histStretch.pct,
      adversePct: histAdverse.pct,
      reach: {
        tgt1: reachRate({ stats: moveStats, hhmm, holdDays: days, side: card.side, pct: histTarget.pct }),
        tgt2: reachRate({ stats: moveStats, hhmm, holdDays: days, side: card.side, pct: histStretch.pct }),
        sl: reachRate({ stats: moveStats, hhmm, holdDays: days, side: card.side === 'PE' ? 'CE' : 'PE', pct: histAdverse.pct }),
      },
    } : null,
    holdDays: days,
    thetaDay: round2(g.thetaDay),
    ivUsed: round2(iv * 100),
    optionGamma: g.gamma,
    deltaUsed: round2(Math.abs(delta)),
    horizonAtr: round2(horizonAtr),
    needs: {
      sl: needs.sl && { level: round2(needs.sl.level), pct: round2(needs.sl.pct) },
      tgt1: needs.tgt1 && { level: round2(needs.tgt1.level), pct: round2(needs.tgt1.pct) },
      tgt2: needs.tgt2 && { level: round2(needs.tgt2.level), pct: round2(needs.tgt2.pct) },
    },
    // What the chosen premium targets imply, decay included — the honest check
    // that the target is reachable at all.
    requiredMovePct: (() => {
      const level = spotForPremium({ target: tgt1, spot, strike: card.strike, years, iv, side: card.side, days });
      return level == null || !(spot > 0) ? null : round2((Math.abs(level - spot) / spot) * 100);
    })(),
  };
}

async function enrichWithFuturesAtr(cards, { readFuturesSnapshot, sessionDate, now, log }) {
  if (typeof readFuturesSnapshot !== 'function') return cards;
  return Promise.all(cards.map(async card => {
    try {
      const snapshot = await readFuturesSnapshot(card.symbol, sessionDate);
      return adaptiveLevels({ ...card, atr: futuresAtr(snapshot, card.symbol, sessionDate, now), strategy: orbStrategy(snapshot, card, now) }, { now, moveStats: loadMoveStats(MOVE_STATS_DIR, card.symbol), levelGrid: loadLevelGrid(LEVEL_GRID_DIR, card.symbol) });
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
export async function runAdvisor(market, { obsPath, watches, now = Date.now(), log = () => {}, ask = askTypeSafe, configured = typesafeConfigured, send = sendTelegramObservationCard, getLive = () => null, readFuturesSnapshot = () => null, subscriberChatIds = [], sendSubscriber = (text, chatId) => sendTelegram(text, { chatId, parseMode: 'HTML', retry: true }), sendUpgrade = text => sendTelegram(text, { parseMode: 'HTML', retry: true }) } = {}) {
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
    // Strike and target are chosen together: the same stock move pays very
    // differently per strike, so each candidate carries its priced outcome.
    const scored = scoreStrikes({
      candidates: candidatesWithGamma,
      spot,
      expiry: series?.e ?? null,
      side: watch.bias === 'bearish' ? 'PE' : 'CE',
      now,
      moveStats: loadMoveStats(MOVE_STATS_DIR, watch.symbol),
      levelGrid: loadLevelGrid(LEVEL_GRID_DIR, watch.symbol),
    });
    // The chain still picks the strike (OI/liquidity/ATM); the priced outcome
    // rides along as information, it does not re-order the candidates.
    const byId = new Map(scored.ranked.map(item => [item.id, item]));
    const informed = candidatesWithGamma.map(item => ({ ...item, choice: byId.get(item.id)?.choice ?? null }));
    prepared.push({ ...watch, at: now, date: sessionDate, expiry: series?.e ?? null, spot, spotChangePct, candidates: informed, walls });
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
    // Code-computed early grabs ride alongside the model's cards. The momentum
    // trend gate reads the session futures snapshot: the 15-minute futures
    // slope at `now` for the symbol and for NIFTY.
    const existingForDedupe = loadObservations(obsPath);
    const trendFor = readFuturesSnapshot ? (symbol, at) => {
      try {
        const snap = readFuturesSnapshot(symbol, sessionDate);
        // Only trust a snapshot that is really this symbol's this-session data —
        // corrupt/cross-symbol/future-dated snapshots return null (gate passes).
        if (snap?.symbol !== symbol || snap?.session !== sessionDate) return null;
        const candles = snap?.months?.[0]?.candles;
        if (!Array.isArray(candles)) return null;
        const end = candles.filter(c => Number.isFinite(c?.at) && c.at <= at).at(-1);
        const start = candles.filter(c => Number.isFinite(c?.at) && c.at <= at - 15 * 60_000).at(-1);
        if (!Number.isFinite(end?.close) || !Number.isFinite(start?.close) || !start.close) return null;
        return +(((end.close - start.close) / start.close) * 100).toFixed(2);
      } catch {
        return null;
      }
    } : null;
    const early = earlyCards(market, sessionDate, now, [...existingForDedupe, ...decisions.cards], { trendFor, log });
    if (early.length) log(`advisor early signals: ${early.map(card => `${card.symbol} ${card.strike}${card.side} (${card.early})`).join(', ')}`);
    // RE-ENTRY (owner rule): an SL-hit card whose contract recovers back to
    // the original entry gets ONE fresh best-strike card tagged RE-ENTRY.
    // Two hit paths — a journal-resolved SL (outcome sl) or an intraday hit
    // tracked live across passes. Recovery = live premium back at/above entry.
    if (slHitSession !== sessionDate) { slHitLive.clear(); slHitSession = sessionDate; }
    const reentries = [];
    const premiumOf = card => {
      const series = (market.series ?? []).find(item => item?.s === card.symbol);
      if (!series) return null;
      const rows = typeof card.expiry === 'string' && series?.next?.e === card.expiry ? series.next.r : series?.r;
      const row = (rows ?? []).find(r => Array.isArray(r) && r[0] === card.strike && r[1] === (card.side === 'CE' ? 0 : 1));
      return Array.isArray(row) && Number.isFinite(row[2]) && row[2] > 0 ? row[2] : null;
    };
    for (const prev of existingForDedupe) {
      if (prev.symbol == null || prev.date !== sessionDate || prev.reEntry) continue;
      if (existingForDedupe.some(o => o.symbol === prev.symbol && o.date === prev.date && o.reEntry)) continue;
      if (!Number.isFinite(prev.entry) || !Number.isFinite(prev.sl) || !Number.isFinite(prev.tgt1)) continue;
      if (prev.expiry && prev.expiry < sessionDate) continue;
      const premium = premiumOf(prev);
      if (premium == null) continue;
      const hit = prev.outcome?.status === 'sl' || slHitLive.has(`${prev.symbol}|${prev.date}`) || premium <= prev.sl;
      if (premium <= prev.sl) slHitLive.add(`${prev.symbol}|${prev.date}`);
      if (!hit || premium < prev.entry) continue;
      const series = (market.series ?? []).find(item => item?.s === prev.symbol);
      const chain = chooseChain(series, now);
      if (!chain) continue;
      const candidate = candidateStrikes(chain, prev.bias ?? 'bullish')[0];
      if (!candidate || !(candidate.ltp > MIN_ENTRY_PREMIUM)) continue;
      reentries.push({ prev, chain, candidate });
      slHitLive.delete(`${prev.symbol}|${prev.date}`); // recovered — stop re-arming
    }
    const reCards = reentries.map(({ prev, chain, candidate }) => ({
      id: `${prev.symbol}|${sessionDate}:re1`,
      at: now,
      date: sessionDate,
      symbol: prev.symbol,
      spot: Number.isFinite(chain.sp) ? chain.sp : null,
      spotChangePct: null,
      bias: prev.bias ?? 'bullish',
      side: candidate.side === 0 ? 'CE' : 'PE',
      strike: candidate.strike,
      expiry: chain.e ?? prev.expiry ?? null,
      ...levelsFor(candidate, chainWalls(chain)),
      quality: null,
      strikePickProbability: null,
      oiChangePct: candidate.oiChangePct,
      delta: candidate.delta ?? null,
      iv: candidate.iv ?? null,
      reEntry: 1,
      atr: null,
      disclaimer: DISCLAIMER,
    }));
    if (reCards.length) log(`advisor re-entry cards: ${reCards.map(card => `${card.symbol} ${card.strike}${card.side} (RE-ENTRY)`).join(', ')}`);
    const cards = await enrichWithFuturesAtr([...decisions.cards, ...early, ...reCards], { readFuturesSnapshot, sessionDate, now, log });
    // A card whose measured premium expectancy is negative is not an
    // observation worth acting on — the owner's rule is that a card's target
    // should be achievable, not just possible.
    const minExpectancy = Number(process.env.ADVISOR_MIN_EXPECTANCY ?? 0);
    const skipped = [];
    const kept = [];
    for (const card of cards) {
      const check = acceptCheck(card, minExpectancy);
      if (!check.ok) {
        skipped.push({ symbol: card.symbol, reason: check.reason });
        continue;
      }
      kept.push(card);
    }
    cards.length = 0;
    cards.push(...kept);
    const { skipped: modelSkipped } = decisions;
    skipped.push(...modelSkipped);
    if (cards.length) {
      const freshCards = dedupeObservations(cards);
      const existing = loadObservations(obsPath);
      const existingKeys = new Set(existing.map(observationKey).filter(Boolean));
      // A model card that lands on a key an early signal already holds is a
      // genuine upgrade: the same symbol/session, now confirmed by the model.
      // The owner asked "then it will change later its quality score?" — this
      // is the note that says so. Subscribers get nothing extra: their copy
      // never mentions quality or the model.
      const upgrades = freshCards.filter(card => {
        const key = observationKey(card);
        if (!key || !existingKeys.has(key) || card.early || card.quality == null) return false;
        if (upgradeNotified.has(key)) return false;
        const prior = existing.find(item => observationKey(item) === key);
        return Boolean(prior?.early);
      });
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
      for (const card of upgrades) {
        const key = observationKey(card);
        if (key) upgradeNotified.add(key);
        const text = `🔁 <b>Upgrade · ${card.symbol} ${card.strike}${card.side}</b>\nThis is now a confirmed setup (quality ${Math.round(card.quality * 100)}%) instead of the earlier early signal — same symbol, same expiry ${card.expiry ?? 'nearest'}, entry ${card.entry}, SL ${card.sl}, TGT1 ${card.tgt1}.`;
        try {
          const result = await sendUpgrade(text);
          log(`telegram upgrade ${result?.sent ? 'sent' : 'not sent'}: ${card.symbol} ${Math.round(card.quality * 100)}%`);
        } catch (error) {
          log(`telegram upgrade failed for ${card.symbol}: ${String(error?.message || error)}`);
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
