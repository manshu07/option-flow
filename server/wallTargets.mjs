import { moveFor, reachRate } from './moveStats.mjs';
import { optionIv, premiumAtLevel, yearsToExpiry } from './optionMath.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function entryTime(at) {
  if (!Number.isFinite(at)) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  return hour && minute ? `${hour}:${minute}` : null;
}

function pinLevel(pin) {
  if (typeof pin === 'number' && Number.isFinite(pin) && pin > 0) return pin;
  if (typeof pin !== 'string') return null;
  const match = pin.trim().match(/^(\d+(?:\.\d+)?)(?:CE|PE)$/i);
  return match ? Number(match[1]) : null;
}

function candidatesFor({ spot, side, walls, gamma }) {
  const candidates = [];
  const wall = side === 'CE' ? walls?.resistance : walls?.support;
  if (Number.isFinite(wall?.strike) && wall.strike > 0) {
    candidates.push({ strike: wall.strike, oi: Number.isFinite(wall.oi) && wall.oi > 0 ? wall.oi : 0, kind: side === 'CE' ? 'resistance' : 'support' });
  }
  const pin = pinLevel(gamma?.pin);
  if (pin != null) candidates.push({ strike: pin, oi: 0, kind: 'pin' });
  if (gamma?.regime === 'gamma-short' && Number.isFinite(gamma.flipLevel) && gamma.flipLevel > 0) {
    candidates.push({ strike: gamma.flipLevel, oi: 0, kind: 'flip' });
  }

  const unique = new Map();
  for (const candidate of candidates) {
    if (side === 'CE' ? candidate.strike <= spot : candidate.strike >= spot) continue;
    const prior = unique.get(candidate.strike);
    if (!prior || candidate.oi > prior.oi) unique.set(candidate.strike, candidate);
  }
  return [...unique.values()].sort((a, b) => a.strike - b.strike);
}

function reachPercentile({ stats, hhmm, holdDays, side, pct }) {
  const reached = reachRate({ stats, hhmm, holdDays, side, pct, era: 'recent' });
  return Number.isFinite(reached) ? clamp((1 - reached) * 100, 0, 100) : null;
}

/**
 * Select a wall target for an already-selected contract. This function is
 * deterministic: all clocks and policies arrive in the arguments, and it
 * performs no IO or environment reads. `premiumAtLevel` applies the time decay
 * from entry to the requested hold horizon; `decayPerDay` is retained as
 * audit context and is not subtracted a second time.
 */
export function selectWallTarget({
  spot,
  entry,
  sl,
  expiryDate,
  holdDays,
  decayPerDay = null,
  moveStats,
  walls,
  gamma,
  contract,
  minRR = 2,
  minTgt2RR = 3,
}) {
  const side = contract?.side;
  const at = contract?.at;
  const empty = { basis: 'insufficient', tgt1: null, tgt1Spot: null, tgt1Wall: null, tgt2: null, tgt2Spot: null, tgt2Wall: null, reach: null, rr: null, tgt2Rr: null, reject: null, candidates: [], ivSource: null };
  if (!(spot > 0 && entry > 0 && sl > 0 && sl < entry)
    || (side !== 'CE' && side !== 'PE') || !Number.isFinite(at)
    || !Number.isFinite(holdDays) || holdDays < 0 || !(minRR > 0 && minTgt2RR > 0)) {
    return { ...empty, reject: { reason: 'invalid card pricing inputs' } };
  }

  const hhmm = entryTime(at);
  const years = yearsToExpiry(expiryDate, at);
  if (!(Number.isFinite(years) && years > 0)) return { ...empty, reject: { reason: 'invalid option expiry' } };
  const iv = optionIv({ premium: entry, spot, strike: contract.strike, years, side, captured: contract.iv });
  if (!(Number.isFinite(iv) && iv > 0)) return { ...empty, reject: { reason: 'option IV unavailable' }, ivSource: 'unavailable' };
  const ivSource = Number.isFinite(contract.iv) && contract.iv >= 5 && contract.iv <= 150 ? 'stored' : 'gamma-inverted';
  const wallsInScope = candidatesFor({ spot, side, walls, gamma });
  if (!wallsInScope.length) return { ...empty, reject: { reason: 'no bias-side wall or gamma level' }, ivSource };
  const favorable = moveFor({ stats: moveStats, hhmm, holdDays, side, percentile: 85, era: 'recent' });
  if (!favorable || !(Number.isFinite(favorable.pct) && favorable.pct > 0)) {
    return {
      ...empty,
      reject: { reason: 'missing p85 favorable-move history' },
      candidates: wallsInScope.map(wall => ({ ...wall, premium: null, rr: null, pct: null, reachPercentile: null, reject: 'missing p85 favorable-move history' })),
      ivSource,
    };
  }
  const days = Math.max(1, Math.min(Math.floor(holdDays), Math.floor(years * 365)));
  const direction = side === 'PE' ? -1 : 1;
  const cap = spot * (1 + direction * favorable.pct / 100);
  if (!(cap > 0)) return { ...empty, reject: { reason: 'invalid p85 favorable level' }, ivSource };

  const evaluated = wallsInScope.map(wall => {
    const withinReach = direction > 0 ? wall.strike <= cap : wall.strike >= cap;
    const pct = Math.abs((wall.strike / spot - 1) * 100);
    const percentile = reachPercentile({ stats: moveStats, hhmm, holdDays, side, pct });
    const premium = withinReach ? premiumAtLevel({ level: wall.strike, strike: contract.strike, years, iv, side, days }) : null;
    const risk = entry - sl;
    const rr = Number.isFinite(premium) && premium > entry ? (premium - entry) / risk : null;
    let reject = null;
    if (!withinReach) reject = 'beyond p85 favorable move';
    else if (!(Number.isFinite(premium) && premium > entry)) reject = 'decay leaves no premium gain';
    else if (!(rr >= minRR)) reject = `reward:risk below ${minRR}`;
    return { ...wall, premium, rr, pct, reachPercentile: percentile, reject };
  });

  const passing = evaluated.filter(candidate => candidate.reject == null)
    .sort((a, b) => b.oi - a.oi || Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const first = passing[0];
  if (!first) {
    const reject = evaluated.length
      ? evaluated.every(candidate => candidate.reject === 'beyond p85 favorable move') ? 'no wall within p85 favorable move'
        : evaluated.every(candidate => candidate.reject === 'decay leaves no premium gain') ? 'decay leaves no positive premium target'
          : `no wall target meets reward:risk ${minRR}`
      : 'no bias-side wall or gamma level';
    return {
      ...empty,
      reject: { reason: reject },
      candidates: evaluated,
      ivSource,
      p85MovePct: favorable.pct,
      decayPerDay,
    };
  }

  const next = passing.filter(candidate => direction > 0
    ? candidate.strike > first.strike && candidate.premium > first.premium && candidate.rr >= minTgt2RR
    : candidate.strike < first.strike && candidate.premium > first.premium && candidate.rr >= minTgt2RR)
    .sort((a, b) => Math.abs(a.strike - first.strike) - Math.abs(b.strike - first.strike) || b.oi - a.oi)[0] ?? null;
  const reached = reachRate({ stats: moveStats, hhmm, holdDays, side, pct: first.pct, era: 'recent' });
  return {
    basis: 'walls+decay',
    tgt1: first.premium,
    tgt1Spot: first.strike,
    tgt2: next?.premium ?? null,
    tgt2Spot: next?.strike ?? null,
    tgt1Wall: { strike: first.strike, oi: first.oi, kind: first.kind },
    tgt2Wall: next ? { strike: next.strike, oi: next.oi, kind: next.kind } : null,
    reach: { tgt1: reached, tgt2: next ? reachRate({ stats: moveStats, hhmm, holdDays, side, pct: next.pct, era: 'recent' }) : null },
    rr: first.rr,
    tgt2Rr: next?.rr ?? null,
    reject: null,
    candidates: evaluated,
    ivSource,
    p85MovePct: favorable.pct,
    decayPerDay,
  };
}
