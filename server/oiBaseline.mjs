function contractKey(symbol, expiry, strike, side) {
  return `${symbol}|${expiry ?? ''}|${strike}|${side}`;
}

/** Build a previous-session OI lookup from an already captured market file. */
export function capturePreviousOiBaseline(market) {
  const baseline = new Map();
  for (const series of Array.isArray(market?.series) ? market.series : []) {
    if (typeof series?.s !== 'string') continue;
    for (const row of Array.isArray(series.r) ? series.r : []) {
      if (!Array.isArray(row) || !Number.isFinite(row[0]) || (row[1] !== 0 && row[1] !== 1)
        || !Number.isFinite(row[4]) || row[4] <= 0) continue;
      baseline.set(contractKey(series.s, series.e, row[0], row[1]), row[4]);
    }
  }
  return baseline;
}

/** Fill only absent/non-positive prevOi, matching exact symbol, expiry, strike, and side. */
export function fillMissingPrevOi(market, baseline) {
  if (!(baseline instanceof Map) || !Array.isArray(market?.series) || baseline.size === 0) return { market, filled: 0 };
  let filled = 0;
  const series = market.series.map(item => {
    if (typeof item?.s !== 'string' || !Array.isArray(item.r)) return item;
    let changed = false;
    const rows = item.r.map(row => {
      if (!Array.isArray(row) || !Number.isFinite(row[0]) || (row[1] !== 0 && row[1] !== 1)
        || !Number.isFinite(row[4]) || row[4] <= 0 || (Number.isFinite(row[5]) && row[5] > 0)) return row;
      const previousOi = baseline.get(contractKey(item.s, item.e, row[0], row[1]));
      if (!Number.isFinite(previousOi) || previousOi <= 0) return row;
      const copy = row.slice();
      copy[5] = previousOi;
      changed = true;
      filled++;
      return copy;
    });
    return changed ? { ...item, r: rows } : item;
  });
  return { market: filled ? { ...market, series } : market, filled };
}
