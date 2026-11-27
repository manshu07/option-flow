/**
 * Seed the persisted level-hits-fired set from ACTUAL captured touches.
 *   node scripts/seedLevelHits.mjs [date]
 *
 * For every card dated <date> (default: today), walks that day's captured
 * minute files from card.at onward and marks sl/tgt1/tgt2 as fired when the
 * level was touched at any point. Covers old cards whose alerts fired before
 * the persisted fired-set existed (owner 2026-11-27: hits must alert exactly
 * once — old and new alike).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const date = process.argv[2] ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const dir = path.join(ROOT, 'server', 'data', 'dhan', date);
const store = JSON.parse(readFileSync(path.join(ROOT, 'server', 'data', 'observations.json'), 'utf8'));
const firedPath = path.join(ROOT, 'server', 'data', 'level-hits-fired.json');

const dayKey = new Date().toISOString().slice(0, 10);
const fired = (() => {
  try {
    const saved = JSON.parse(readFileSync(firedPath, 'utf8'));
    if (saved?.dayKey === dayKey && Array.isArray(saved.keys)) return new Set(saved.keys);
  } catch { /* fresh */ }
  return new Set();
})();

const files = readdirSync(dir).filter(f => /^[01]\d{3}\.json$/.test(f)).sort();
const byMinute = files.map(f => ({ at: Date.parse(`${date}T${f.slice(0, 2)}:${f.slice(2)}:00+05:30`), f: path.join(dir, f) }));

const cards = (Array.isArray(store.cards) ? store.cards : []).filter(c => c.date === date);
let seeded = 0;
for (const card of cards) {
  let series = [];
  for (const { at, f } of byMinute) {
    if (at < card.at) continue;
    try {
      const snap = JSON.parse(readFileSync(f, 'utf8'));
      const s = (snap.series ?? []).find(x => x.s === card.symbol);
      if (!s) continue;
      const rows = [...(s.r ?? []), ...(s.next?.r ?? [])];
      const side = card.side === 'CE' ? 0 : 1;
      const v = rows.filter(r => Number(r[0]) === Number(card.strike) && Number(r[1]) === side).map(r => Number(r[2]))[0];
      if (Number.isFinite(v)) series.push({ at, v });
    } catch { /* skip bad minute */ }
  }
  for (const [key, cmp] of [['sl', v => v <= card.sl], ['tgt1', v => v >= card.tgt1], ['tgt2', v => v >= card.tgt2]]) {
    const fireKey = `${card.id}|${key}`;
    if (fired.has(fireKey)) continue;
    if (series.some(p => cmp(p.v))) { fired.add(fireKey); seeded++; }
  }
}

writeFileSync(firedPath, JSON.stringify({ dayKey, keys: [...fired].slice(-800) }));
console.log(`seeded ${seeded} new fired keys — set total ${fired.size}`);
