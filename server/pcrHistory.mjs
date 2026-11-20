const WINDOW_MS = 15 * 60_000;
const DEFAULT_LIMIT = 100;

function pcrForSeries(series) {
  let putOi = 0;
  let callOi = 0;
  for (const row of Array.isArray(series?.r) ? series.r : []) {
    if (!Array.isArray(row) || !Number.isFinite(row[4]) || row[4] <= 0) continue;
    if (row[1] === 1) putOi += row[4];
    else if (row[1] === 0) callOi += row[4];
  }
  if (!(Number.isFinite(putOi) && Number.isFinite(callOi) && callOi > 0)) return null;
  const pcr = putOi / callOi;
  return Number.isFinite(pcr) ? pcr : null;
}

/** In-memory, session-scoped near-chain PCR history for early-card filtering. */
export function createPcrHistory(limit = DEFAULT_LIMIT) {
  const maxPoints = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const bySymbol = new Map();
  let session = null;

  function resetForSession(date) {
    if (date === session) return;
    session = date;
    bySymbol.clear();
  }

  function record(seriesList, at) {
    if (!Number.isFinite(at)) return;
    for (const series of Array.isArray(seriesList) ? seriesList : []) {
      if (typeof series?.s !== 'string' || !series.s) continue;
      const pcr = pcrForSeries(series);
      if (pcr == null) continue;
      const points = bySymbol.get(series.s) ?? [];
      const existing = points.findIndex(point => point.t === at);
      if (existing >= 0) points[existing] = { t: at, pcr };
      else points.push({ t: at, pcr });
      points.sort((a, b) => a.t - b.t);
      if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
      bySymbol.set(series.s, points);
    }
  }

  function shiftFor(symbol, at) {
    if (typeof symbol !== 'string' || !Number.isFinite(at)) return null;
    const points = bySymbol.get(symbol);
    if (!points?.length) return null;
    const fromAt = at - WINDOW_MS;
    let from = null;
    let to = null;
    for (const point of points) {
      if (point.t <= fromAt) from = point;
      if (point.t <= at) to = point;
      else break;
    }
    if (!from || !to || from.t === to.t || !(from.pcr > 0)) return null;
    const shift = ((to.pcr - from.pcr) / from.pcr) * 100;
    return Number.isFinite(shift) ? +shift.toFixed(2) : null;
  }

  return {
    resetForSession,
    record,
    shiftFor,
    pointsFor: symbol => (bySymbol.get(symbol) ?? []).map(point => ({ ...point })),
  };
}
