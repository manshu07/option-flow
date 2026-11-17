import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { sendTelegramObservationCard } from './telegram.mjs';
import { askTypeSafe, typesafeConfigured } from './typesafe.mjs';
import { inFireWindow } from './alerts.mjs';
import { gammaProfile, gammaRiskFreeRate, parseGammaSymbols } from '../src/features/market-flow/gammaModel.ts';

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
 *   3. code routes: quality ≥ 0.7 and a decisive strike pick → an observation
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
const QUALITY_YES = 0.7;
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
    const oiChangePct = Number.isFinite(row[5]) && row[5] > 0 ? ((row[4] - row[5]) / row[5]) * 100 : null;
    const premiumChangePct = Number.isFinite(row[3]) && row[3] > 0 ? ((row[2] - row[3]) / row[3]) * 100 : null;
    const itm = side === 0 ? strike < spot : strike > spot;
    const otm = side === 0 ? strike > spot : strike < spot;
    candidates.push({
      id: `c${candidates.length + 1}`,
      strike, side, ltp: row[2], prevClose: row[3], premiumChangePct, oi: row[4], prevOi: row[5], oiChangePct,
      placement: itm ? 'in-the-money — moves faster, costs more' : otm ? 'out-of-the-money — cheaper, needs a bigger move' : 'at-the-money — the default pick',
    });
    if (candidates.length === 3) break;
  }
  return candidates;
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
      disclaimer: DISCLAIMER,
    });
  }
  return { cards, skipped };
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

/**
 * One advisor pass over the triage's watch list. Never throws; every failure
 * is logged and the observations file keeps its previous content.
 */
export async function runAdvisor(market, { obsPath, watches, now = Date.now(), log = () => {}, ask = askTypeSafe, configured = typesafeConfigured, send = sendTelegramObservationCard, getLive = () => null } = {}) {
  const sessionDate = typeof market?.date === 'string' ? market.date : null;
  if (!configured()) return { skipped: 'not configured' };
  if (!inFireWindow(now)) return { skipped: 'outside fire window' };
  if (!Array.isArray(watches) || !watches.length) return { skipped: 'no watched symbols' };
  const seriesFor = symbol => (market?.series ?? []).find(item => item?.s === symbol) ?? null;
  const prepared = [];
  for (const watch of watches) {
    const series = seriesFor(watch.symbol);
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
    const spotOf = p => seriesFor(p.symbol) ?? {};
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
    const { cards, skipped } = advisorDecisions(prepared, answers);
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
      }
    }
    for (const s of skipped) log(`advisor skipped ${s.symbol}: ${s.reason}`);
    return { written: cards.length, cards };
  } catch (error) {
    log(`advisor failed (observations unchanged): ${String(error?.message || error)}`);
    return { skipped: 'failed', error: String(error?.message || error) };
  }
}
