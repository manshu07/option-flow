/**
 * ORB scanner runtime — turns the pure model into a list of rows and the two
 * daily pushes. Reading futures snapshots is the only I/O here; the state
 * machine itself lives in orbModel.mjs.
 */
import { readFileSync } from 'node:fs';
import { orbRow, orbMessage, chainSideOi } from './orbModel.mjs';

/** The day's two ORB pushes, in IST minutes since midnight. */
export const ORB_SLOTS = [
  { key: '09:35', minute: 9 * 60 + 35 },
  { key: '10:05', minute: 10 * 60 + 5 },
];

const DAY_MS = 86_400_000;
const IST_OFFSET = 19_800_000; // +05:30

export function istMinuteOfDay(at) {
  if (!Number.isFinite(at)) return null;
  return Math.floor((((at + IST_OFFSET) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
}

/**
 * Which push is due right now, if any. Each slot fires once per session and
 * only inside a short grace window, so a slow build never pushes at 11:00.
 */
export function orbSlotDue(at, sent = new Set(), { grace = 12 } = {}) {
  const minute = istMinuteOfDay(at);
  if (minute == null) return null;
  for (const slot of ORB_SLOTS) {
    if (sent.has(slot.key)) continue;
    if (minute >= slot.minute && minute < slot.minute + grace) return slot.key;
  }
  return null;
}

/** symbol → sector from public/underlyings.json (read once, then cached). */
export function loadSectorMap(path, readFile = readFileSync) {
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'));
    const list = Array.isArray(parsed?.underlyings) ? parsed.underlyings : [];
    const map = new Map();
    for (const item of list) if (typeof item?.symbol === 'string' && typeof item?.sector === 'string') map.set(item.symbol, item.sector);
    return map;
  } catch { return new Map(); }
}

/**
 * The morning's leading sectors: the sectors of the day's strongest movers
 * (absolute spot change ≥ 1%, top 3). Empty = the sector gate stays neutral.
 */
export function leadingSectors(series, sectors, { top = 3, minPct = 1 } = {}) {
  const movers = [];
  for (const item of series ?? []) {
    const spot = Number(item?.sp);
    const prev = Number(item?.pc);
    if (!(spot > 0) || !(prev > 0)) continue;
    const pct = ((spot - prev) / prev) * 100;
    if (Math.abs(pct) < minPct) continue;
    movers.push({ symbol: item.s, sector: sectors?.get?.(item.s) ?? null, pct });
  }
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const out = [];
  for (const mover of movers) {
    if (!mover.sector || out.includes(mover.sector)) continue;
    out.push(mover.sector);
    if (out.length >= top) break;
  }
  return out;
}

const STATE_RANK = { 'broken-out': 0, 'entered-zone': 1, 'extended-wait': 2, armed: 3, building: 4, done: 5 };

/**
 * Scan the whole universe from the persisted futures snapshots.
 * `readSnapshot(symbol)` returns a futures snapshot or null.
 */
export function orbScan({ session, now = Date.now(), series = [], readSnapshot, sectors = new Map(), top = 3 }) {
  const leading = leadingSectors(series, sectors, { top });
  const rows = [];
  for (const item of series) {
    const symbol = item?.s;
    if (typeof symbol !== 'string') continue;
    let snapshot = null;
    try { snapshot = readSnapshot?.(symbol) ?? null; } catch { snapshot = null; }
    const month = Array.isArray(snapshot?.months) ? snapshot.months[0] : null;
    rows.push(orbRow({
      symbol,
      session: snapshot?.session ?? session,
      now,
      candles: Array.isArray(month?.candles) ? month.candles : [],
      prevOi: month?.prevOi ?? null,
      prevHigh: month?.prevHigh ?? null,
      prevLow: month?.prevLow ?? null,
      sector: sectors.get(symbol) ?? null,
      leadingSectors: leading,
      chainOi: chainSideOi(item?.r),
    }));
  }
  rows.sort((a, b) => {
    if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
    const rank = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    if (rank !== 0) return rank;
    return Math.abs(b.openMovePct ?? 0) - Math.abs(a.openMovePct ?? 0);
  });
  return {
    at: now,
    session,
    leading,
    rows,
    counts: {
      scanned: rows.length,
      building: rows.filter(row => row.state === 'building').length,
      armed: rows.filter(row => row.state === 'armed').length,
      breakouts: rows.filter(row => row.qualifies).length,
      extended: rows.filter(row => row.state === 'extended-wait' || row.state === 'entered-zone').length,
    },
  };
}

export { orbMessage };