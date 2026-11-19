/**
 * Strike choice — the same stock move pays very differently on different
 * strikes, so the strike and the target must be chosen together.
 *
 * For each liquid candidate this prices the policy's target/stop pair with
 * Black-Scholes at the hold's date (decay included) and ranks by what the
 * trade actually earned in the replayed history: rupee expectancy first,
 * reward/risk as the tie-break. A deep-OTM lottery leg can show a huge %
 * target and still be the worst choice — this makes that visible.
 */
import { optionIv, yearsToExpiry } from './optionMath.mjs';
import { cellFor, pickPair, pricePair } from './levelPolicy.mjs';
import { liveRegime } from './moveRegime.mjs';

/**
 * @param candidates liquid candidates from candidateStrikes (strike, side, ltp, iv, delta)
 * @returns the candidates with `choice` attached, best first; `pair` describes
 *          the shared target/stop policy so the card can quote its evidence.
 */
export function scoreStrikes({ candidates, spot, expiry, side, now = Date.now(), holdDays = 2, moveStats = null, levelGrid = null, policy = 'achievable' }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const years = yearsToExpiry(expiry, now);
  if (!list.length || !(spot > 0) || !years) return { ranked: list.map(c => ({ ...c, choice: null })), pair: null, regime: null };
  const days = Math.max(1, Math.min(holdDays, Math.floor(years * 365)));
  const regime = liveRegime(moveStats?.recentCloses, spot);
  const hhmm = (() => { const d = new Date(now + 19_800_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; })();
  const cell = cellFor({ grid: levelGrid, holdDays: days, hhmm, regime, side });
  const pair = pickPair(cell, { policy });

  const ranked = list.map(candidate => {
    const entry = Number(candidate.ltp);
    const iv = optionIv({ premium: entry, spot, strike: candidate.strike, years, side, captured: candidate.iv });
    if (!pair || !(entry > 0) || !iv) return { ...candidate, choice: null };
    const priced = pricePair({ pair, spot, strike: candidate.strike, entry, years, iv, side, days });
    if (!priced) return { ...candidate, choice: null };
    return {
      ...candidate,
      choice: {
        ivUsed: Number((iv * 100).toFixed(1)),
        targetPremium: Number(priced.targetPremium.toFixed(2)),
        stopPremium: Number(priced.stopPremium.toFixed(2)),
        gain: Number(priced.gain.toFixed(2)),
        risk: Number(priced.risk.toFixed(2)),
        gainPct: Number(((priced.gain / entry) * 100).toFixed(1)),
        rewardRisk: priced.rewardRisk == null ? null : Number(priced.rewardRisk.toFixed(2)),
        expectancyPremium: Number(priced.expectancyPremium.toFixed(2)),
        expectancyPct: priced.expectancyPct == null ? null : Number(priced.expectancyPct.toFixed(1)),
        winRate: pair.winRate,
        lossRate: pair.lossRate,
      },
    };
  });

  ranked.sort((a, b) => {
    const left = a.choice?.expectancyPremium ?? -Infinity;
    const right = b.choice?.expectancyPremium ?? -Infinity;
    if (left !== right) return right - left;
    return (b.choice?.rewardRisk ?? -Infinity) - (a.choice?.rewardRisk ?? -Infinity);
  });
  return { ranked, pair, regime, days };
}