/**
 * Level policy — choose the target/stop pair for a card from the measured
 * path backtest, then price it in premium terms with decay.
 *
 * The owner's rule: the target must be achievable and the stop should almost
 * never hit. Both are now measurable (`winRate`, `lossRate` from
 * scripts/backtestLevels.mjs), but they trade off against expectancy: a stop
 * that never hits is a stop that loses the whole premium when it finally does.
 * So a policy states its constraints, and the card prints what that choice
 * actually earned historically — never a bare "70% chance".
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { premiumAtLevel } from './optionMath.mjs';

const cache = new Map();

/** Buy-side options need reward:risk, not just a hit rate. */
export const MIN_REWARD_RISK = Number(process.env.ADVISOR_MIN_RR ?? 2);

export const POLICIES = {
  // The owner's stated preference: the target is reached often, the stop rarely.
  // Achievable: the target is reached often. A stop that never hits is
  // impossible alongside a 1:2 payoff, so the loss limit is honest, not zero.
  achievable: { minWin: 0.7, maxLoss: 0.2, label: 'achievable' },
  // Rarely stopped, accepting a lower hit rate.
  safe: { minWin: 0.5, maxLoss: 0.05, label: 'safe' },
  // Looser hit rate, still a rarely-hit stop.
  balanced: { minWin: 0.55, maxLoss: 0.05, label: 'balanced' },
  // Whatever earned the most, regardless of hit rate.
  expectancy: { minWin: 0, maxLoss: 1, label: 'expectancy' },
};

export function loadLevelGrid(dir, symbol) {
  const key = `${dir}|${symbol}`;
  if (cache.has(key)) return cache.get(key);
  const file = path.join(dir, `${symbol}.json`);
  let grid = null;
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.instrument === 'EQ' && Array.isArray(parsed.cells)) grid = parsed;
    } catch { grid = null; }
  }
  cache.set(key, grid);
  return grid;
}

/** The backtest cell matching this card: hold or intraday entry, regime, side. */
export function cellFor({ grid, holdDays, hhmm, regime, side }) {
  if (!grid) return null;
  const scope = holdDays > 0 ? `hold:${holdDays}` : `intraday:${hhmm}`;
  return grid.cells.find(cell => cell.scope === scope && cell.regime === regime && cell.side === side)
    // A regime with too few samples falls back to the pooled range cell.
    ?? grid.cells.find(cell => cell.scope === scope && cell.regime === 'range' && cell.side === side)
    ?? null;
}

/**
 * Pick a pair under a policy. Ranking is by expectancy in % of the stock's
 * price, so a high win rate that loses money cannot win the selection.
 */
export function pickPair(cell, { policy = 'achievable', minSamples = 120 } = {}) {
  if (!cell || cell.samples < minSamples) return null;
  const rule = POLICIES[policy] ?? POLICIES.achievable;
  const eligible = cell.pairs.filter(pair => pair.winRate >= rule.minWin && pair.lossRate <= rule.maxLoss);
  const pool = eligible.length ? eligible : cell.pairs;
  const best = [...pool].sort((a, b) => b.expectancyPct - a.expectancyPct)[0] ?? null;
  if (!best) return null;
  return { ...best, policy: rule.label, constrained: eligible.length > 0, samples: cell.samples, scope: cell.scope, regime: cell.regime, side: cell.side };
}

/**
 * What that pair means for the option: premium target, premium stop, and the
 * expectancy in rupees of premium, decay included.
 */
export function pricePair({ pair, spot, strike, entry, years, iv, side, days }) {
  if (!pair || !(spot > 0 && entry > 0 && years > 0 && iv > 0)) return null;
  const dir = side === 'PE' ? -1 : 1;
  const targetLevel = spot * (1 + dir * pair.targetPct / 100);
  const stopLevel = spot * (1 - dir * pair.stopPct / 100);
  const targetPremium = premiumAtLevel({ level: targetLevel, strike, years, iv, side, days });
  const stopPremium = premiumAtLevel({ level: stopLevel, strike, years, iv, side, days });
  if (!Number.isFinite(targetPremium) || !Number.isFinite(stopPremium)) return null;
  const gain = targetPremium - entry;
  const risk = entry - stopPremium;
  // Open trades are marked at their average underlying excursion.
  const openLevel = spot * (1 + dir * (pair.avgOpenR * pair.stopPct) / 100);
  const openPremium = premiumAtLevel({ level: openLevel, strike, years, iv, side, days });
  const openGain = Number.isFinite(openPremium) ? openPremium - entry : 0;
  const expectancy = pair.winRate * gain - pair.lossRate * risk + pair.openRate * openGain;
  return {
    targetLevel, stopLevel,
    targetPremium, stopPremium,
    gain, risk,
    rewardRisk: risk > 0 ? gain / risk : null,
    expectancyPremium: expectancy,
    expectancyPct: entry > 0 ? (expectancy / entry) * 100 : null,
  };
}
/**
 * Choose the pair FOR THIS STRIKE: price every candidate pair in premium terms
 * (decay included), keep only those that pay at least `minRewardRisk`, honour
 * the policy's hit/stop limits, and never place a target beyond the chain wall
 * the stock has to break first. Ranked by rupee expectancy.
 *
 * Returns null with a reason when nothing qualifies — an honest "no trade here"
 * beats a target that cannot pay.
 */
export function pickPairForStrike({
  cell, spot, strike, entry, years, iv, side, days,
  policy = 'achievable', minRewardRisk = MIN_REWARD_RISK, wall = null, minSamples = 120,
}) {
  if (!cell || cell.samples < minSamples) return { pair: null, reason: 'not enough history' };
  const rule = POLICIES[policy] ?? POLICIES.achievable;
  const dir = side === 'PE' ? -1 : 1;
  const scored = [];
  for (const candidate of cell.pairs) {
    const priced = pricePair({ pair: candidate, spot, strike, entry, years, iv, side, days });
    if (!priced || !(priced.risk > 0)) continue;
    const rewardRisk = priced.gain / priced.risk;
    // A target past the wall needs a breakout first — not an achievable ask.
    if (Number.isFinite(wall) && wall > 0 && (dir > 0 ? priced.targetLevel > wall : priced.targetLevel < wall)) continue;
    scored.push({ candidate, priced, rewardRisk });
  }
  if (!scored.length) return { pair: null, reason: 'no pair could be priced' };
  const payable = scored.filter(item => item.rewardRisk >= minRewardRisk);
  if (!payable.length) {
    const best = [...scored].sort((a, b) => b.rewardRisk - a.rewardRisk)[0];
    return { pair: null, reason: `best reward:risk is 1:${best.rewardRisk.toFixed(2)} — below 1:${minRewardRisk}`, bestRewardRisk: best.rewardRisk };
  }
  const withinPolicy = payable.filter(item => item.candidate.winRate >= rule.minWin && item.candidate.lossRate <= rule.maxLoss);
  const pool = withinPolicy.length ? withinPolicy : payable;
  const best = [...pool].sort((a, b) => b.priced.expectancyPremium - a.priced.expectancyPremium)[0];
  return {
    pair: {
      ...best.candidate,
      policy: rule.label,
      constrained: withinPolicy.length > 0,
      samples: cell.samples,
      scope: cell.scope,
      regime: cell.regime,
      side: cell.side,
      rewardRisk: best.rewardRisk,
    },
    priced: best.priced,
    reason: null,
  };
}
