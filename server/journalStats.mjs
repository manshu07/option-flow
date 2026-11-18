/**
 * Per-signal accuracy analytics over the observation journal.
 *
 * The day tally answers "what happened"; these buckets answer "which card type
 * actually works" — early vs model, ORB ✓ vs ✗, side, DTE. Pure functions over
 * the persisted cards, so they are testable without I/O.
 */

const DAY_MS = 86_400_000;
const QUALITY_GATE = 0.65;

const RESOLVED = new Set(['tgt1', 'sl', 'ambiguous']);

const statusOf = card => (card?.outcome && typeof card.outcome === 'object' ? String(card.outcome.status ?? 'open') : 'open');
const isResolved = card => RESOLVED.has(statusOf(card));

/** Days between the card's session and its expiry (IST 15:30 both sides). */
export function dteOf(card) {
  if (typeof card?.date !== 'string' || typeof card?.expiry !== 'string') return null;
  const from = Date.parse(`${card.date}T15:30:00+05:30`);
  const to = Date.parse(`${card.expiry}T15:30:00+05:30`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

export const BUCKET_LABELS = {
  'signal:early-momentum': 'early · momentum',
  'signal:early-build-fast': 'early · build-fast',
  'signal:model': 'model ≥65%',
  'signal:model-low': 'model <65%',
  'orb:orb-yes': 'ORB ✓',
  'orb:orb-no': 'ORB ✗',
  'orb:orb-none': 'no ORB tag',
  'side:ce': 'CE',
  'side:pe': 'PE',
  'dte:dte-0-3': 'DTE 0–3',
  'dte:dte-4-7': 'DTE 4–7',
  'dte:dte-8-plus': 'DTE 8+',
};

function bucketsFor(card) {
  const signal = card?.early === 'build-fast' ? 'early-build-fast'
    : card?.early === 'momentum' ? 'early-momentum'
      : Number.isFinite(card?.quality) && card.quality >= QUALITY_GATE ? 'model' : 'model-low';
  const orb = card?.strategy?.qualifies === true ? 'orb-yes' : card?.strategy?.qualifies === false ? 'orb-no' : 'orb-none';
  const side = card?.side === 'PE' ? 'pe' : 'ce';
  const dte = dteOf(card);
  const out = [`signal:${signal}`, `orb:${orb}`, `side:${side}`];
  if (dte != null) out.push(`dte:${dte <= 3 ? 'dte-0-3' : dte <= 7 ? 'dte-4-7' : 'dte-8-plus'}`);
  return out;
}

/**
 * @param cards persisted observation cards
 * @returns buckets sorted by resolved desc, cards desc; thin buckets dropped.
 */
export function signalStats(cards, { minSample = 1 } = {}) {
  const held = new Map();
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    for (const key of bucketsFor(card)) {
      const bucket = held.get(key) ?? { key, label: BUCKET_LABELS[key] ?? key, cards: 0, resolved: 0, tgt1: 0, sl: 0, ambiguous: 0, open: 0, rSum: 0, rCount: 0 };
      bucket.cards += 1;
      const status = statusOf(card);
      if (status === 'tgt1') bucket.tgt1 += 1;
      else if (status === 'sl') bucket.sl += 1;
      else if (status === 'ambiguous') bucket.ambiguous += 1;
      else bucket.open += 1;
      if (isResolved(card)) {
        bucket.resolved += 1;
        const r = card.outcome?.r;
        if (Number.isFinite(r)) { bucket.rSum += r; bucket.rCount += 1; }
      }
      held.set(key, bucket);
    }
  }
  return [...held.values()]
    .filter(bucket => bucket.cards >= minSample)
    .map(({ rSum, rCount, ...bucket }) => ({
      ...bucket,
      winRate: bucket.resolved ? bucket.tgt1 / bucket.resolved : null,
      avgR: rCount ? rSum / rCount : null,
    }))
    .sort((a, b) => b.resolved - a.resolved || b.cards - a.cards || a.key.localeCompare(b.key));
}

/** The compact `/journal` section: signal buckets plus the ORB split. */
export function signalStatsLines(cards, { limit = 3 } = {}) {
  const stats = signalStats(cards);
  const pick = [
    ...stats.filter(item => item.key.startsWith('signal:')).slice(0, limit),
    ...stats.filter(item => item.key === 'orb:orb-yes' || item.key === 'orb:orb-no'),
  ];
  return pick
    .filter(item => item.resolved > 0)
    .map(item => {
      const win = item.winRate == null ? '—' : `${Math.round(item.winRate * 100)}%`;
      const r = item.avgR == null ? '—' : `${item.avgR >= 0 ? '+' : '−'}${Math.abs(item.avgR).toFixed(2)}`;
      return `• ${item.label}: ${item.cards} cards · ${item.tgt1} TGT1 · ${item.sl} SL · win ${win} · avg R ${r}`;
    });
}