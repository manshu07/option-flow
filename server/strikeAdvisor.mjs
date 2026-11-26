import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sendTelegram, sendTelegramObservationCard } from './telegram.mjs';
import { observationSubscriberCaption } from './observationCardSvg.mjs';
import { askTypeSafe, typesafeConfigured } from './typesafe.mjs';
import { BROADCAST_FOOTER, inFireWindow, marketMovers } from './alerts.mjs';
import { gammaProfile, gammaRiskFreeRate, parseGammaSymbols } from '../src/features/market-flow/gammaModel.ts';
import { atrSummary } from '../src/features/market-flow/atrModel.ts';
import { openingRange, sessionVwap } from './orbModel.mjs';
import { greeks, optionIv, premiumAtLevel, spotForPremium, levelFor, yearsToExpiry } from './optionMath.mjs';
import { loadMoveStats, moveFor, reachRate } from './moveStats.mjs';
import { loadLevelGrid, cellFor, pickPairForStrike } from './levelPolicy.mjs';
import { liveRegime, REGIME_LOOKBACK } from './moveRegime.mjs';
import { pcrForNearSeries } from './pcrHistory.mjs';
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
// Index policy (owner-approved 2026-11-23): indices move smaller than stocks, so the
// early move gate and the model quality floor are relaxed for them, and expiry-day
// (0-DTE) index chains stay cardable — the expiry-day cut is exactly what he trades.
const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX', 'SENSEX50', 'NIFTYNXT50', 'FOCIT']);
const MOVE_GATE = Number(process.env.ADVISOR_MOVE_GATE) || 1.5;
const INDEX_MOVE_GATE = Number(process.env.ADVISOR_INDEX_MOVE_GATE) || 0.7;
const INDEX_QUALITY_YES = Number(process.env.ADVISOR_INDEX_QUALITY) || 0.5;
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
export function chooseChain(series, now = Date.now(), symbol = null) {
  const next = series?.next;
  if (!next || typeof next.e !== 'string' || typeof series?.e !== 'string') return series;
  const expiryAt = Date.parse(`${series.e}T15:30:00+05:30`);
  if (!Number.isFinite(expiryAt)) return series;
  const merged = { ...series, e: next.e, sp: next.sp, pc: next.pc, atm: next.atm, r: next.r, t: next.t ?? series.t, tp: next.tp ?? series.tp };
  const dte = (expiryAt - now) / (24 * 60 * 60_000);
  // Index expiry-day exception: inside 1 DTE an index stays on its own expiry —
  // the expiry-day cut is exactly the trade he wants carded (theta warning still renders).
  if (INDEX_SYMBOLS.has(symbol) && dte <= 1) return series;
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
export function advisorDecisions(watches, answers, { qualityYes = QUALITY_YES, pickMin = PICK_MIN, indexQualityYes = INDEX_QUALITY_YES } = {}) {
  const cards = [];
  const skipped = [];
  for (const watch of watches) {
    const symbol = watch.symbol;
    const quality = normalizeQuality(answers?.[`quality_${symbol}`]?.noul);
    const pick = answers?.[`strike_${symbol}`];
    const candidates = watch.candidates ?? [];
    const chosen = candidates.find(c => c.id === pick?.choice);
    const gate = INDEX_SYMBOLS.has(symbol) ? indexQualityYes : qualityYes;
    if (!(quality >= gate) || !chosen || (pick?.probabilities?.[pick.choice] ?? 0) < pickMin) {
      skipped.push({ symbol, reason: !(quality >= gate) ? `quality ${quality == null ? 'unknown' : `${Math.round(quality * 100)}%`}` : 'strike pick not decisive' });
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
 * 15-minute futures slope, must not fight a sharp PCR shift, and must wait out
 * the opening chop and get option-premium confirmation. The shared range gate
 * applies to both momentum and build-fast cards. All filters run before a card
 * takes one of the two per-pass slots.
 */
export function earlyCards(market, date, now, existing = [], { max = 2, minExpectancy = Number(process.env.ADVISOR_MIN_EXPECTANCY ?? 0), priceCard, trendFor, pcrShiftFor = null, regimeFor = null, sectorFor = null, sectorBudget = null, sectorCardCap = sectorCardCapFromEnv(), log = () => {} } = {}) {
  if (!market || typeof date !== 'string') return [];
  const price = priceCard ?? (card => adaptiveLevels(card, { now, moveStats: loadMoveStats(MOVE_STATS_DIR, card.symbol), levelGrid: loadLevelGrid(LEVEL_GRID_DIR, card.symbol) }));
  const budget = sectorBudget ?? createSectorCardBudget(existing, date, sectorFor, sectorCardCap);
  const trendGateMin = Number(process.env.MOMENTUM_TREND_GATE_PCT) || 0.1;
  const configuredPcrGate = Number(process.env.MOMENTUM_PCR_GATE_PCT ?? 3);
  const pcrGateMin = Number.isFinite(configuredPcrGate) && configuredPcrGate > 0 ? configuredPcrGate : 3;
  const rangeGateEnabled = process.env.ADVISOR_RANGE_GATE !== '0';
  const pcrShifts = new Map();
  const pcrShiftAtEntry = symbol => {
    if (pcrShifts.has(symbol)) return pcrShifts.get(symbol);
    let shift = null;
    try {
      const value = pcrShiftFor?.(symbol, now);
      if (Number.isFinite(value)) shift = value;
    } catch { /* missing history is displayed as unavailable */ }
    pcrShifts.set(symbol, shift);
    return shift;
  };
  // Opening chop: the first minutes after 09:15 produced the 09:40-10:34 SL
  // cluster — momentum waits MOMENTUM_SKIP_OPEN_MIN minutes (default 15).
  const skipOpenMin = Number(process.env.MOMENTUM_SKIP_OPEN_MIN) || 15;
  const openTotal = 9 * 60 + 15 + skipOpenMin;
  const openCutoff = `${String(Math.floor(openTotal / 60)).padStart(2, '0')}:${String(openTotal % 60).padStart(2, '0')}`;
  const seen = new Set((Array.isArray(existing) ? existing : []).map(card => observationKey(card)).filter(Boolean));
  const out = [];
  for (const mover of marketMovers(market)) {
    if (out.length >= max) break;
    if (!Number.isFinite(mover.changePct) || Math.abs(mover.changePct) < (INDEX_SYMBOLS.has(mover.symbol) ? INDEX_MOVE_GATE : MOVE_GATE)) continue;
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
    if (momentum && typeof pcrShiftFor === 'function') {
      const pcrDelta = pcrShiftAtEntry(mover.symbol);
      const against = Number.isFinite(pcrDelta) && (bias === 'bullish' ? pcrDelta >= pcrGateMin : pcrDelta <= -pcrGateMin);
      if (against) {
        const value = `${pcrDelta >= 0 ? '+' : ''}${pcrDelta.toFixed(1)}%`;
        log(`advisor momentum pcr-gate: ${mover.symbol} ${bias} pcrDelta ${value} — skipped`);
        continue;
      }
    }
    if (rangeGateEnabled && typeof regimeFor === 'function') {
      let regime = null;
      try { regime = regimeFor(mover.symbol, now); } catch { /* unknown regime passes */ }
      if (regime === 'range') {
        log(`advisor regime gate: ${mover.symbol} ${bias} regime=range — skipped`);
        continue;
      }
    }
    const key = `${mover.symbol}|${date}`;
    if (seen.has(key)) continue;
    const series = (market.series ?? []).find(item => item?.s === mover.symbol);
    const chain = chooseChain(series, now, mover.symbol);
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
      pcrAtEntry: pcrForNearSeries(series),
      pcrShift: pcrShiftAtEntry(mover.symbol),
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
    const sector = budget.add(card);
    if (!sector.ok) {
      log(`advisor skipped ${mover.symbol}: sector cluster full: ${sector.sector}`);
      continue;
    }
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

function sectorCardCapFromEnv() {
  const configured = process.env.SECTOR_CARD_CAP;
  if (configured == null || configured.trim() === '') return 2;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value >= 0 ? value : 2;
}

function openForSession(card, date) {
  return card?.date === date && (!card.outcome || card.outcome.status === 'open');
}

/** Shared mutable count for the currently accepted session batch. */
export function createSectorCardBudget(existing, date, sectorFor, limit = sectorCardCapFromEnv()) {
  const counts = new Map();
  const keys = new Set();
  const added = new Map();
  const cap = Number.isSafeInteger(limit) && limit >= 0 ? limit : 2;
  const sectorOf = card => {
    try {
      const sector = sectorFor?.(card?.symbol);
      return typeof sector === 'string' && sector ? sector : null;
    } catch { return null; }
  };
  for (const card of Array.isArray(existing) ? existing : []) {
    if (!openForSession(card, date)) continue;
    const sector = sectorOf(card);
    if (!sector) continue;
    const key = observationKey(card);
    if (key && keys.has(key)) continue;
    if (key) keys.add(key);
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }
  return {
    add(card) {
      const sector = sectorOf(card);
      if (!sector) return { ok: true, sector: null };
      const key = observationKey(card);
      if (key && keys.has(key)) return { ok: true, sector, alreadyCounted: true };
      if ((counts.get(sector) ?? 0) >= cap) return { ok: false, sector };
      counts.set(sector, (counts.get(sector) ?? 0) + 1);
      const token = key ?? card;
      if (key) keys.add(key);
      added.set(token, sector);
      return { ok: true, sector, added: true };
    },
    release(card) {
      const key = observationKey(card);
      const token = key ?? card;
      const sector = added.get(token);
      if (!sector) return;
      added.delete(token);
      if (key) keys.delete(key);
      const count = counts.get(sector) ?? 0;
      if (count <= 1) counts.delete(sector);
      else counts.set(sector, count - 1);
    },
    count(sector) { return counts.get(sector) ?? 0; },
  };
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
  const unresolved = unique.filter(card => !card?.outcome || typeof card.outcome !== 'object' || card.outcome.status === 'open');
  const resolved = unique.filter(card => !unresolved.includes(card));
  // A re-entry depends on its original SL card for audit/history. Pin that
  // original even when ordinary resolved history is evicted at the store cap.
  const reEntryOriginalKeys = new Set(unique.filter(card => card?.reEntry)
    .map(card => `${card.symbol}|${card.date}`));
  const pinnedOriginals = new Set(resolved.filter(card => !card?.reEntry
    && reEntryOriginalKeys.has(observationKey(card))));
  const resolvedToKeep = Math.max(0, limit - unresolved.length - pinnedOriginals.size);
  const recentResolved = resolved.filter(card => !pinnedOriginals.has(card));
  const keptResolved = new Set(recentResolved.slice(0, resolvedToKeep));
  return unique.filter(card => unresolved.includes(card) || pinnedOriginals.has(card) || keptResolved.has(card));
}

/** Read + normalise the observations store. */
export function loadObservations(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.cards) ? dedupeObservations(parsed.cards) : [];
  } catch { return []; }
}

export function saveObservations(path, cards, maxCards = MAX_CARDS) {
  const tmp = `${path}.tmp`;
  const retained = retainObservations(cards, maxCards);
  writeFileSync(tmp, JSON.stringify({ cards: retained }, null, 2));
  renameSync(tmp, path);
  return retained;
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
  const out = {
    ...priced,
    sl: Number.isFinite(priced.sl) ? snapTick(priced.sl) : priced.sl,
    tgt1: Number.isFinite(priced.tgt1) ? snapTick(priced.tgt1) : priced.tgt1,
    tgt2: Number.isFinite(priced.tgt2) ? snapTick(priced.tgt2) : priced.tgt2,
  };
  const entry = Number(card?.entry);
  const basis = String(priced.levelsBasis || '');
  // Do not loosen the existing no-edge/decay refusals. Only index option
  // premium levels can be degenerate from spot-scale ATR conversion.
  const degenerate = INDEX_SYMBOLS.has(card?.symbol) && basis !== 'decay-too-heavy' && basis !== 'no-edge'
    && Number.isFinite(entry) && entry > 0
    && (!Number.isFinite(out.sl) || out.sl < entry * 0.05 || out.sl >= entry
      || !Number.isFinite(out.tgt1) || out.tgt1 <= entry || out.tgt1 > entry * 3);
  if (degenerate) {
    const indexFallback = indexPercentileFallback(card, opts, entry);
    if (indexFallback) return { ...out, ...indexFallback };
    const fixed = levelsFor({ ltp: entry }, { support: card.support ?? null, resistance: card.resistance ?? null });
    const spot = Number(card?.spot);
    const years = yearsToExpiry(card?.expiry, Number.isFinite(opts?.now) ? opts.now : Date.now());
    const iv = years && spot > 0 ? optionIv({ premium: entry, spot, strike: card.strike, years, side: card.side, captured: card.iv }) : null;
    const days = Number(out.holdDays) || Number(opts?.holdDays) || 2;
    const delta = Number.isFinite(card?.delta) && Math.abs(card.delta) > 0 ? Math.abs(card.delta)
      : Number.isFinite(out.deltaUsed) && out.deltaUsed > 0 ? out.deltaUsed : null;
    const need = level => {
      const underlying = iv ? spotForPremium({ target: level, spot, strike: card.strike, years, iv, side: card.side, days }) : null;
      const premiumMove = level - entry;
      const direction = card.side === 'PE' ? -Math.sign(premiumMove) : Math.sign(premiumMove);
      if (Number.isFinite(underlying) && spot > 0 && direction * (underlying - spot) > 0) {
        return { level: round2(underlying), pct: round2((Math.abs(underlying - spot) / spot) * 100) };
      }
      if (!(delta > 0 && spot > 0)) return null;
      const spotMove = card.side === 'PE' ? -premiumMove / delta : premiumMove / delta;
      return { level: round2(spot + spotMove), pct: round2((Math.abs(spotMove) / spot) * 100) };
    };
    const needs = spot > 0 ? { sl: need(fixed.sl), tgt1: need(fixed.tgt1), tgt2: need(fixed.tgt2) } : null;
    return {
      ...out,
      ...fixed,
      levelsBasis: 'index-fixed-sane',
      needs,
      history: null,
      backtest: null,
      requiredMovePct: needs?.tgt1?.pct ?? null,
    };
  }
  return out;
}

function indexPercentileFallback(card, opts, entry) {
  const stats = opts?.moveStats;
  const spot = card?.spot;
  const strike = card?.strike;
  const side = card?.side;
  const now = Number.isFinite(opts?.now) ? opts.now : Date.now();
  if (!stats || !(Number.isFinite(spot) && spot > 0 && Number.isFinite(strike) && strike > 0)
    || (side !== 'CE' && side !== 'PE')) return null;
  const years = yearsToExpiry(card?.expiry, now);
  const iv = years ? optionIv({ premium: entry, spot, strike, years, side, captured: card?.iv }) : null;
  if (!(Number.isFinite(years) && years > 0 && Number.isFinite(iv) && iv > 0)) return null;
  const days = Math.max(1, Math.min(Number(opts?.holdDays) || Number(card?.holdDays) || 2, Math.floor(years * 365)));
  const hhmm = hhmmIst(Number.isFinite(card?.at) ? card.at : now);
  const adverseSide = side === 'PE' ? 'CE' : 'PE';

  for (const targetPercentile of [30, 20, 10]) {
    const targetMove = moveFor({ stats, hhmm, holdDays: days, side, percentile: targetPercentile });
    if (!(Number.isFinite(targetMove?.pct) && targetMove.pct > 0)) continue;
    const targetDistance = spot * targetMove.pct / 100;
    const targetSpot = side === 'PE' ? spot - targetDistance : spot + targetDistance;
    const rawTgt1 = premiumAtLevel({ level: targetSpot, strike, years, iv, side, days });
    const tgt1 = Number.isFinite(rawTgt1) ? snapTick(rawTgt1) : null;
    if (!(Number.isFinite(tgt1) && tgt1 > entry && tgt1 <= entry * 3)) continue;

    for (const stopPercentile of [85, 70, 50, 30, 20, 10]) {
      const adverseMove = moveFor({ stats, hhmm, holdDays: days, side: adverseSide, percentile: stopPercentile });
      if (!(Number.isFinite(adverseMove?.pct) && adverseMove.pct > 0)) continue;
      const stopDistance = spot * adverseMove.pct / 100;
      const stopSpot = side === 'PE' ? spot + stopDistance : spot - stopDistance;
      const rawSl = premiumAtLevel({ level: stopSpot, strike, years, iv, side, days });
      const sl = Number.isFinite(rawSl) ? snapTick(rawSl) : null;
      if (!(Number.isFinite(sl) && sl >= entry * 0.05 && sl < entry)) continue;

      const stretchMove = moveFor({ stats, hhmm, holdDays: days, side, percentile: 50 });
      const stretchDistance = Number.isFinite(stretchMove?.pct) ? spot * stretchMove.pct / 100 : null;
      const stretchSpot = stretchDistance == null ? null : side === 'PE' ? spot - stretchDistance : spot + stretchDistance;
      const rawTgt2 = stretchSpot == null ? null : premiumAtLevel({ level: stretchSpot, strike, years, iv, side, days });
      const tgt2 = Number.isFinite(rawTgt2) && rawTgt2 > tgt1 && rawTgt2 <= entry * 3 ? snapTick(rawTgt2) : null;
      const slNeed = levelFor({ spot, move: -stopDistance, side });
      const tgt1Need = levelFor({ spot, move: targetDistance, side });
      const tgt2Need = tgt2 == null || stretchDistance == null ? null : levelFor({ spot, move: stretchDistance, side });
      const pct = need => need && spot > 0 ? round2((Math.abs(need.level - spot) / spot) * 100) : null;
      const targetStock = spotForPremium({ target: tgt1, spot, strike, years, iv, side, days });
      return {
        sl,
        tgt1,
        tgt2,
        levelsBasis: 'index-percentile-fallback',
        needs: {
          sl: slNeed && { level: round2(slNeed.level), pct: pct(slNeed) },
          tgt1: tgt1Need && { level: round2(tgt1Need.level), pct: pct(tgt1Need) },
          tgt2: tgt2Need && { level: round2(tgt2Need.level), pct: pct(tgt2Need) },
        },
        history: {
          instrument: stats.instrument ?? 'INDEX',
          era: targetMove.era ?? 'recent',
          holdDays: days,
          samples: targetMove.samples ?? 0,
          targetPct: targetMove.pct,
          stretchPct: stretchMove?.pct ?? null,
          adversePct: adverseMove.pct,
          reach: {
            tgt1: reachRate({ stats, hhmm, holdDays: days, side, pct: targetMove.pct }),
            tgt2: tgt2 == null ? null : reachRate({ stats, hhmm, holdDays: days, side, pct: stretchMove.pct }),
            sl: reachRate({ stats, hhmm, holdDays: days, side: adverseSide, pct: adverseMove.pct }),
          },
        },
        backtest: null,
        requiredMovePct: targetStock == null ? null : round2((Math.abs(targetStock - spot) / spot) * 100),
      };
    }
  }
  return null;
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
export async function runAdvisor(market, { obsPath, watches, now = Date.now(), log = () => {}, ask = askTypeSafe, configured = typesafeConfigured, send = sendTelegramObservationCard, getLive = () => null, readFuturesSnapshot = () => null, pcrShiftFor = null, sectorFor = null, subscriberChatIds = [], sendSubscriber = (text, chatId) => sendTelegram(text, { chatId, parseMode: 'HTML', retry: true }), sendUpgrade = text => sendTelegram(text, { parseMode: 'HTML', retry: true }) } = {}) {
  const sessionDate = typeof market?.date === 'string' ? market.date : null;
  if (!configured()) return { skipped: 'not configured' };
  if (!inFireWindow(now)) return { skipped: 'outside fire window' };
  if (!Array.isArray(watches) || !watches.length) return { skipped: 'no watched symbols' };
  const seriesFor = symbol => (market?.series ?? []).find(item => item?.s === symbol) ?? null;
  const prepared = [];
  for (const watch of watches) {
    const series = chooseChain(seriesFor(watch.symbol), now, watch.symbol);
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
    const spotOf = p => chooseChain(seriesFor(p.symbol), now, p.symbol) ?? {};
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
    const shiftCache = new Map();
    const pcrShiftAtCard = symbol => {
      if (shiftCache.has(symbol)) return shiftCache.get(symbol);
      let shift = null;
      try {
        const value = pcrShiftFor?.(symbol, now);
        if (Number.isFinite(value)) shift = value;
      } catch { /* unavailable PCR history remains null on the card */ }
      shiftCache.set(symbol, shift);
      return shift;
    };
    const withPcrContext = card => ({
      ...card,
      pcrAtEntry: pcrForNearSeries(seriesFor(card.symbol)),
      pcrShift: pcrShiftAtCard(card.symbol),
    });
    const modelCards = decisions.cards.map(withPcrContext);
    // Code-computed early grabs ride alongside the model's cards. They reuse
    // the same session PCR history, futures slope and live regime as pricing.
    const existingForDedupe = loadObservations(obsPath);
    const sectorCardCap = sectorCardCapFromEnv();
    const sectorBudget = createSectorCardBudget(existingForDedupe, sessionDate, sectorFor, sectorCardCap);
    const minExpectancy = Number(process.env.ADVISOR_MIN_EXPECTANCY ?? 0);
    const skipped = [];
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
    const regimeFor = (symbol, at) => {
      const series = seriesFor(symbol);
      const moveStats = loadMoveStats(MOVE_STATS_DIR, symbol);
      // FALLBACK (2026-11-25 owner report: zero index cards while the regime gate
      // classified every symbol "range (thin history)"): 209/210 move-stats files
      // predate the recentCloses field, so the classifier saw 1 close and always
      // returned range. Merge the official bhavcopy fut-stats recentCloses when
      // the primary store is missing them — the fut-stats store is the sanctioned
      // 467-session history (server/data/fut-stats/<SYM>.json).
      let statsCloses = moveStats?.recentCloses;
      if (!Array.isArray(statsCloses) || !statsCloses.length) {
        try {
          const futStats = JSON.parse(readFileSync(join(process.cwd(), 'server', 'data', 'fut-stats', `${symbol}.json`), 'utf8'));
          if (Array.isArray(futStats?.recentCloses) && futStats.recentCloses.length) statsCloses = futStats.recentCloses;
        } catch { /* no fut-stats file — behave as before */ }
      }
      const closes = (Array.isArray(statsCloses) ? statsCloses : [])
        .map(item => Number(item?.close ?? item))
        .filter(value => Number.isFinite(value) && value > 0);
      const livePrice = Number.isFinite(series?.sp) && series.sp > 0 ? series.sp : null;
      const closesUsed = closes.length + (livePrice == null ? 0 : 1);
      if (closesUsed < REGIME_LOOKBACK) {
        log(`advisor regime history: ${symbol} ${closesUsed}/${REGIME_LOOKBACK} closes — classified as range (thin history)`);
      }
      // Match adaptiveLevels exactly: use its liveRegime classifier and this
      // market build's spot, without changing historical regime semantics.
      return liveRegime(statsCloses, livePrice);
    };
    // Model candidates are already built; validate them before they occupy a
    // sector slot or influence the cap available to code-computed early cards.
    const pricedModelCards = await enrichWithFuturesAtr(modelCards, { readFuturesSnapshot, sessionDate, now, log });
    const acceptedModelCards = [];
    for (const card of pricedModelCards) {
      const check = acceptCheck(card, minExpectancy);
      if (!check.ok) {
        skipped.push({ symbol: card.symbol, reason: check.reason });
        continue;
      }
      const sector = sectorBudget.add(card);
      if (!sector.ok) {
        skipped.push({ symbol: card.symbol, reason: `sector cluster full: ${sector.sector}` });
        continue;
      }
      acceptedModelCards.push(card);
    }
    // Keep every model proposal in the dedupe input, including proposals
    // rejected by the new sector cap, so a gate can never create an early card
    // for the same symbol/session that the existing model path already saw.
    const early = earlyCards(market, sessionDate, now, [...existingForDedupe, ...modelCards], {
      trendFor,
      pcrShiftFor,
      regimeFor,
      sectorFor,
      sectorBudget,
      sectorCardCap,
      log,
    });
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
      const chain = chooseChain(series, now, prev.symbol);
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
      pcrAtEntry: pcrForNearSeries(seriesFor(prev.symbol)),
      pcrShift: pcrShiftAtCard(prev.symbol),
      delta: candidate.delta ?? null,
      iv: candidate.iv ?? null,
      reEntry: 1,
      atr: null,
      disclaimer: DISCLAIMER,
    }));
    if (reCards.length) log(`advisor re-entry cards: ${reCards.map(card => `${card.symbol} ${card.strike}${card.side} (RE-ENTRY)`).join(', ')}`);
    const cardsToFinish = await enrichWithFuturesAtr([...early, ...reCards], { readFuturesSnapshot, sessionDate, now, log });
    const kept = [];
    for (const card of cardsToFinish) {
      const check = acceptCheck(card, minExpectancy);
      if (!check.ok) {
        sectorBudget.release(card);
        skipped.push({ symbol: card.symbol, reason: check.reason });
        continue;
      }
      const sector = sectorBudget.add(card);
      if (!sector.ok) {
        skipped.push({ symbol: card.symbol, reason: `sector cluster full: ${sector.sector}` });
        continue;
      }
      kept.push(card);
    }
    const cards = [...acceptedModelCards, ...kept];
    const { skipped: modelSkipped } = decisions;
    skipped.push(...modelSkipped);
    if (cards.length) {
      const existing = loadObservations(obsPath);
      const existingByKey = new Map(existing.map(card => [observationKey(card), card]).filter(([key]) => Boolean(key)));
      const freshCards = dedupeObservations(cards);
      // Cards of one pass shared a single `at`, so the app's tie-break order
      // drifted from the telegram send order (owner 2026-11-26: "new cards ki
      // sequence change ho gayi"). Give each card its own +1ms creation stamp:
      // newest-first sorting now matches creation AND send order exactly.
      freshCards.forEach((card, index) => {
        // An upgrade (model card replacing an early card on the same key) must
        // KEEP the original creation time — the owner saw ENRIN's time change
        // on every pass because the replacement stamped a new `at`.
        const prior = existingByKey.get(observationKey(card));
        card.at = prior ? prior.at : now + index;
      });
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
      saveObservations(obsPath, [...freshCards, ...existing]);
      const fresh = freshCards.filter(card => {
        const key = observationKey(card);
        return key && !existingKeys.has(key) && !notified.has(key);
      });
      for (const card of freshCards) {
        const key = observationKey(card);
        if (key) notified.add(key);
      }
      // Telegram must read newest-first too (owner: cards must match the
      // app's order) — the app sorts newest-first, so send the same direction.
      for (const card of [...fresh].reverse()) {
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

// ─── MCX futures-direct cards (MCX_FULL_SPEC C4) ────────────────────────────
// MCX futures carry no option chains, so the card trades the FUTURE itself:
// entry = futures LTP, levels = MCX-FUT percentile bands (favourable p30/p70,
// adverse p85 — reach-rate semantics), bias from price + OI momentum. The
// direction gate for MCX is the symbol's own fut-stats regime (down blocks a
// bullish card; capitulation exemptions are a later story).

const MCX_STATS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data', 'fut-stats');
const mcxStatsCache = new Map();
function mcxStatsFor(symbol) {
  if (mcxStatsCache.has(symbol)) return mcxStatsCache.get(symbol);
  let stats = null;
  try {
    const parsed = JSON.parse(readFileSync(join(MCX_STATS_DIR, `${symbol}.json`), 'utf8'));
    if (parsed?.instrument === 'MCX-FUT') stats = parsed;
  } catch { /* missing store = no card, never guessed levels */ }
  mcxStatsCache.set(symbol, stats);
  return stats;
}

export function mcxCards(market, date, now, existing = [], { readFuturesSnapshot = null, log = () => {} } = {}) {
  if (!market || typeof date !== 'string') return [];
  const seen = new Set((Array.isArray(existing) ? existing : []).map(card => observationKey(card)).filter(Boolean));
  const out = [];
  const minMove = Number(process.env.MCX_MOVE_GATE ?? 0.7);
  const minOi = Number(process.env.MCX_OI_GATE ?? 2);
  for (const series of Array.isArray(market?.series) ? market.series : []) {
    if (series?.exchange !== 'MCX' || !series?.s) continue;
    const symbol = series.s;
    const key = `${symbol}|${date}`;
    if (seen.has(key)) continue;
    const sp = Number(series.sp);
    const pc = Number(series.pc);
    if (!(sp > 0) || !(pc > 0)) continue;
    const changePct = (sp / pc - 1) * 100;
    if (Math.abs(changePct) < minMove) continue;
    const stats = mcxStatsFor(symbol);
    if (!stats) { log(`advisor mcx: ${symbol} no MCX-FUT stats — skipped`); continue; }
    const bias = changePct > 0 ? 'bullish' : 'bearish';
    // Regime agreement: a down-regime commodity rejects bullish builds (and
    // vice versa). NATURALGAS sits in range — range passes both sides.
    const regime = stats.lastRegime;
    if ((regime === 'down' && bias === 'bullish') || (regime === 'up' && bias === 'bearish')) {
      log(`advisor mcx regime gate: ${symbol} ${bias} regime=${regime} — skipped`);
      continue;
    }
    const snapshot = readFuturesSnapshot ? readFuturesSnapshot(symbol, date) : null;
    const month = (Array.isArray(snapshot?.months) ? snapshot.months : []).find(m => typeof m?.date === 'string' && m.date >= date) ?? snapshot?.months?.[0] ?? null;
    const lastOi = Number(month?.candles?.at(-1)?.oi);
    const prevOi = Number(month?.prevOi);
    const oiPct = Number.isFinite(lastOi) && Number.isFinite(prevOi) && prevOi > 0 ? (lastOi / prevOi - 1) * 100 : null;
    const buildConfirmed = oiPct != null && oiPct >= minOi;
    const momentumStrong = Math.abs(changePct) >= 1.2;
    if (!buildConfirmed && !momentumStrong) {
      log(`advisor mcx: ${symbol} ${bias} move ${changePct.toFixed(2)}% oi ${oiPct == null ? 'n/a' : oiPct.toFixed(1) + '%'} — no confirmation, skipped`);
      continue;
    }
    // Percentile levels on the FUTURE price (spot=fut for a futures-direct card).
    const day = stats.daily?.['1'];
    const favourable = bias === 'bullish' ? day?.all?.up : day?.all?.down;
    const adverse = bias === 'bullish' ? day?.all?.down : day?.all?.up;
    if (!favourable?.p30 || !adverse?.p85) { log(`advisor mcx: ${symbol} stats incomplete — skipped`); continue; }
    const dir = bias === 'bullish' ? 1 : -1;
    const tgt1 = Number((sp * (1 + dir * favourable.p30 / 100)).toFixed(2));
    const tgt2 = Number((sp * (1 + dir * favourable.p70 / 100)).toFixed(2));
    const sl = Number((sp * (1 - dir * adverse.p85 / 100)).toFixed(2));
    const card = {
      id: key,
      at: now,
      date,
      exchange: 'MCX',
      symbol,
      spot: sp,
      spotChangePct: round2(changePct),
      bias,
      side: 'FUT',
      strike: null,
      expiry: series.e ?? null,
      entry: sp,
      sl,
      tgt1,
      tgt2,
      levelsBasis: 'mcx-fut-history',
      oiChangePct: oiPct,
      quality: null,
      strikePickProbability: null,
      early: 'mcx',
      atr: null,
      disclaimer: DISCLAIMER,
    };
    seen.add(key);
    out.push(card);
  }
  return out;
}

/** MCX advisor pass: compute, merge into the store, notify owner (stripped copy to subscribers). */
export async function runMcxCards(market, { obsPath, date, now, readFuturesSnapshot = null, subscriberChatIds = [], send = null, log = () => {} } = {}) {
  try {
    const existing = loadObservations(obsPath);
    const cards = mcxCards(market, date, now, existing, { readFuturesSnapshot, log });
    if (!cards.length) return { written: 0, cards: [] };
    const merged = saveObservations(obsPath, [...existing, ...cards]);
    for (const card of cards) {
      try {
        if (typeof send === 'function') {
          await send(`MCX ${card.bias.toUpperCase()} · ${card.symbol} FUT\nEntry ${card.entry} · SL ${card.sl} · TGT1 ${card.tgt1} · TGT2 ${card.tgt2}\nMove ${card.spotChangePct}% · OI ${card.oiChangePct == null ? 'n/a' : card.oiChangePct.toFixed(1) + '%'} · ${card.expiry ?? ''}\n${DISCLAIMER}`);
          for (const chat of subscriberChatIds) {
            try {
              await sendTelegram(chat, `MCX ${card.bias.toUpperCase()} · ${card.symbol} FUT\nEntry ${card.entry} · SL ${card.sl} · TGT1 ${card.tgt1} · TGT2 ${card.tgt2}\nMove ${card.spotChangePct}% · ${card.expiry ?? ''}\n${BROADCAST_FOOTER}`);
            } catch (e) { log(`telegram mcx card ${card.symbol} subscriber not sent: ${String(e?.message || e)}`); }
          }
        }
      } catch (e) { log(`telegram mcx card ${card.symbol} owner not sent: ${String(e?.message || e)}`); }
    }
    return { written: cards.length, cards };
  } catch (error) {
    log(`mcx advisor failed (observations unchanged): ${String(error?.message || error)}`);
    return { skipped: 'failed', error: String(error?.message || error) };
  }
}
