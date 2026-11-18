/**
 * Cross-expiry participation — where the day's open interest is actually
 * going: into the near expiry, into the next one, or out of both.
 *
 * Read-only aggregate over the captured market file (near block + the additive
 * `next` block from the December work). No new subscriptions, no pushes.
 *
 * Honesty rules:
 *   - a symbol without a `next` block is "not captured", never "zero activity";
 *   - a side whose baseline (prevOi) is missing is excluded from percentages,
 *     and a symbol with no usable baseline reports nulls, not 0%.
 */

const PIVOT_PCT = 2; // ±2% of OI is treated as real movement, not noise

function sideTotals(rows) {
  const totals = { ce: { oi: 0, prevOi: 0, legs: 0, basis: 0 }, pe: { oi: 0, prevOi: 0, legs: 0, basis: 0 } };
  for (const row of rows ?? []) {
    if (!Array.isArray(row)) continue;
    const side = row[1] === 1 ? 'pe' : row[1] === 0 ? 'ce' : null;
    if (!side) continue;
    const oi = Number(row[4]);
    const prevOi = Number(row[5]);
    if (!(oi > 0)) continue;
    totals[side].legs += 1;
    if (prevOi > 0) {
      totals[side].oi += oi;
      totals[side].prevOi += prevOi;
      totals[side].basis += 1;
    }
  }
  return totals;
}

const pctOf = side => (side.prevOi > 0 ? ((side.oi - side.prevOi) / side.prevOi) * 100 : null);

/** One expiry block's OI totals — exported so tests can build blocks without the scanner. */
export function chainBlock(chain) {
  if (!chain || !Array.isArray(chain.r) || !chain.r.length) return null;
  const totals = sideTotals(chain.r);
  const usable = totals.ce.basis + totals.pe.basis > 0;
  const oiSum = totals.ce.oi + totals.pe.oi;
  const prevOiSum = totals.ce.prevOi + totals.pe.prevOi;
  const total = usable && prevOiSum > 0 ? ((oiSum - prevOiSum) / prevOiSum) * 100 : null;
  return {
    expiry: typeof chain.e === 'string' ? chain.e : null,
    legs: totals.ce.legs + totals.pe.legs,
    cePct: usable ? pctOf(totals.ce) : null,
    pePct: usable ? pctOf(totals.pe) : null,
    totalPct: total,
    oiSum: usable ? oiSum : null,
    prevOiSum: usable ? prevOiSum : null,
    delta: usable ? oiSum - prevOiSum : 0,
  };
}

/** One classification from the two blocks: where the money went today. */
export function participationLabel(near, next) {
  if (!near) return 'not captured';
  if (!next) return 'not captured';
  const nearPct = near.totalPct;
  const nextPct = next.totalPct;
  if (nearPct == null || nextPct == null) return 'baseline missing';
  if (nextPct >= PIVOT_PCT && nearPct <= -PIVOT_PCT) return 'rollover';
  if (nextPct >= PIVOT_PCT) return 'fresh build';
  if (nextPct <= -PIVOT_PCT && nearPct <= -PIVOT_PCT) return 'unwind';
  if (nextPct <= -PIVOT_PCT) return 'next unwind';
  return 'steady';
}

export const PARTICIPATION_LABELS = ['rollover', 'fresh build', 'unwind', 'next unwind', 'steady', 'baseline missing', 'not captured'];

/**
 * Per-symbol near/next OI picture, biggest next-expiry build first.
 * `series` is the market file's series array (the shape the board already reads).
 */
export function participation(series, { limit = 0 } = {}) {
  const rows = [];
  for (const item of series ?? []) {
    if (!item || typeof item.s !== 'string') continue;
    const near = chainBlock({ r: item.r, e: item.e });
    const next = item.next ? chainBlock({ r: item.next.r, e: item.next.e }) : null;
    rows.push({
      symbol: item.s,
      spot: Number.isFinite(Number(item.sp)) ? Number(item.sp) : null,
      spotChangePct: Number(item.sp) > 0 && Number(item.pc) > 0 ? ((Number(item.sp) - Number(item.pc)) / Number(item.pc)) * 100 : null,
      near,
      next,
      label: participationLabel(near, next),
      nextDelta: next?.delta ?? null,
    });
  }
  rows.sort((a, b) => {
    const left = a.label === 'not captured' ? -Infinity : a.nextDelta ?? -Infinity;
    const right = b.label === 'not captured' ? -Infinity : b.nextDelta ?? -Infinity;
    if (left !== right) return right - left;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
  const counted = rows.filter(row => row.label !== 'not captured');
  const byLabel = Object.fromEntries(PARTICIPATION_LABELS.map(label => [label, rows.filter(row => row.label === label).length]));
  const totals = {
    symbols: rows.length,
    captured: counted.length,
    notCaptured: rows.length - counted.length,
    nearPct: aggregatePct(counted.map(row => row.near)),
    nextPct: aggregatePct(counted.map(row => row.next)),
    byLabel,
  };
  return { rows: limit > 0 ? rows.slice(0, limit) : rows, totals, at: Date.now() };
}

/** OI-weighted aggregate: total change ÷ total baseline across the given blocks. */
function aggregatePct(blocks) {
  let delta = 0;
  let base = 0;
  for (const item of blocks ?? []) {
    if (!item || !Number.isFinite(item.oiSum) || !Number.isFinite(item.prevOiSum) || item.prevOiSum <= 0) continue;
    delta += item.oiSum - item.prevOiSum;
    base += item.prevOiSum;
  }
  return base > 0 ? (delta / base) * 100 : null;
}