/**
 * Prev-day OI seeding from a captured series snapshot.
 *
 * The seed exists so a boot does not have to sweep the chain endpoint for
 * every leg: a stored minute already carries the numbers. Two traps it must
 * avoid:
 *
 *  1. **Expiry-blind keys.** Matching on strike+side alone gave the December
 *     leg the November leg's previous-day OI, which turned every next-expiry
 *     OI change into a fake −90% "unwind".
 *  2. **Wrong day for the next expiry.** Dhan reports `previous_oi = 0` for
 *     next-month contracts, so there is no upstream baseline to copy. The only
 *     honest baseline is the previous session's *close OI* for that same
 *     expiry — which only exists once we have captured that expiry's close.
 *
 * Pure: rows + windows + which session the snapshot is from → a record plan.
 */

const num = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

function rowMapFor(chain) {
  const rows = Array.isArray(chain?.r) ? chain.r : [];
  return new Map(rows.filter(Array.isArray).map(row => [`${row[0]}:${row[1]}`, row]));
}

/**
 * @param seriesRow one symbol's market-file row (`{ e, r, next: { e, r } }`)
 * @param windows  `[{ expiry, window: number[], ids: Map<number, {CE, PE}> }]`
 * @param options  `{ session, snapshotSession }` — when the snapshot is from an
 *                 earlier session its close OI (row[4]) is the baseline; when
 *                 it is the same session its own prevOi (row[5]) is.
 * @returns `[{ legKey, prevOi, prevClose, prevVolume }]`
 */
export function seedPlan(seriesRow, windows, { session = null, snapshotSession = null } = {}) {
  if (!seriesRow || !Array.isArray(seriesRow.r)) return [];
  const nearMap = rowMapFor(seriesRow);
  const nextMap = seriesRow.next ? rowMapFor(seriesRow.next) : null;
  const nearExpiry = typeof seriesRow.e === 'string' ? seriesRow.e : null;
  const earlierSession = Boolean(session && snapshotSession && snapshotSession < session);
  const plan = [];
  for (const entry of windows ?? []) {
    if (!entry || !Array.isArray(entry.window) || !entry.ids) continue;
    const isNextWindow = nearExpiry != null && entry.expiry != null && entry.expiry !== nearExpiry;
    if (isNextWindow && !nextMap) continue;
    // Same-session snapshot: the next expiry's own baseline never came from
    // upstream, so seeding it would copy the near expiry's numbers again.
    if (isNextWindow && !earlierSession) continue;
    const rows = isNextWindow ? nextMap : nearMap;
    for (const strike of entry.window) {
      const legs = entry.ids.get(strike) ?? {};
      for (const [side, legKey] of [[0, legs.CE], [1, legs.PE]]) {
        if (!legKey) continue;
        const row = rows.get(`${strike}:${side}`);
        if (!row) continue;
        // 18-field leg layout: [strike, side, ltp, prevClose, oi, prevOi, volume, prevVolume, …]
        const prevOi = earlierSession ? num(row[4]) : num(row[5]);
        if (prevOi == null || prevOi <= 0) continue;
        plan.push({ legKey, prevOi, prevClose: num(row[3]), prevVolume: num(row[7]) });
      }
    }
  }
  return plan;
}