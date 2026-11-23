/**
 * Card reach report — how big a target the captured premiums actually reach,
 * and how much a longer hold helps.
 *
 *   node --max-old-space-size=8192 scripts/cardReach.mjs
 *
 * For every observation card it walks the card's own session (from the card's
 * minute onward) and then the following sessions, and records the best
 * favourable premium print in each horizon. Archives are read one day at a
 * time (a day's gz expands to ~400 MB of JSON) — never inside the API process.
 *
 * Output: a reach table (what % of cards would have hit +10/15/20/30/55%) per
 * hold length, so targets can be set from evidence instead of a fixed number.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'server', 'data', 'dhan');
const ARCH = path.join(ROOT, 'server', 'data', 'archives', 'dhan');
const OBS = path.join(ROOT, 'server', 'data', 'observations.json');
const OUT = path.join(ROOT, 'server', 'data', 'card-reach.json');
const TARGETS = [10, 15, 20, 30, 55];
const HORIZONS = [1, 2, 3];

const cards = (JSON.parse(readFileSync(OBS, 'utf8')).cards ?? [])
  .filter(card => typeof card?.date === 'string' && Number.isFinite(card.entry) && card.entry > 0 && card.strike != null);
if (!cards.length) { console.error('no cards to measure'); process.exit(1); }

const keyOf = card => `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
const wanted = new Map(); // day -> Set(contract keys still needing that day)
const days = [...new Set(cards.map(card => card.date))].sort();
const allDays = [
  ...readdirSync(RAW).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)),
  ...(existsSync(ARCH) ? readdirSync(ARCH).filter(name => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name)).map(name => name.slice(0, 10)) : []),
].sort();

for (const card of cards) {
  const start = allDays.indexOf(card.date);
  if (start < 0) continue;
  for (let hop = 0; hop < HORIZONS.at(-1); hop++) {
    const day = allDays[start + hop];
    if (!day) break;
    if (!wanted.has(day)) wanted.set(day, new Map());
    wanted.get(day).set(keyOf(card), { card, hop });
  }
}

// best favourable print per card per hop
const best = new Map(); // cardKey|date -> [hop0, hop1, hop2]
const bump = (card, hop, price) => {
  const id = `${keyOf(card)}|${card.date}`;
  const row = best.get(id) ?? [];
  row[hop] = Math.max(row[hop] ?? 0, price);
  best.set(id, row);
};

const scanSnapshot = (snapshot, day, fromAt = 0) => {
  const need = wanted.get(day);
  if (!need || !Array.isArray(snapshot?.series)) return;
  const at = Number(snapshot.t) || 0;
  for (const series of snapshot.series) {
    for (const row of series.r ?? []) {
      if (!Array.isArray(row)) continue;
      const side = row[1] === 1 ? 'PE' : 'CE';
      const key = `${series.s}|${row[0]}|${side}|${series.e}`;
      const hit = need.get(key);
      if (!hit) continue;
      const { card, hop } = hit;
      // The card's own session counts only from the card's minute onward.
      if (hop === 0 && at < card.at) continue;
      const ltp = Number(row[2]);
      const high = Number(row[13]);
      const price = Math.max(Number.isFinite(ltp) ? ltp : 0, Number.isFinite(high) ? high : 0);
      if (price > 0) bump(card, hop, price);
    }
  }
};

for (const day of [...wanted.keys()].sort()) {
  const rawDir = path.join(RAW, day);
  if (existsSync(rawDir)) {
    const minutes = readdirSync(rawDir).filter(name => /^\d{4}\.json$/.test(name)).sort();
    for (const minute of minutes) {
      try { scanSnapshot(JSON.parse(readFileSync(path.join(rawDir, minute), 'utf8')), day); } catch { /* skip unreadable minute */ }
    }
    console.log(`${day}: ${minutes.length} raw minutes scanned`);
    continue;
  }
  const gz = path.join(ARCH, `${day}.json.gz`);
  if (!existsSync(gz)) continue;
  const payload = JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'));
  const minutes = payload?.minutes;
  const entries = Array.isArray(minutes) ? minutes : Object.entries(minutes ?? {}).map(([hhmm, value]) => [hhmm, value]);
  let count = 0;
  for (const entry of entries) {
    const snapshot = Array.isArray(entry) ? entry[1] : entry;
    scanSnapshot(snapshot?.series ? snapshot : { t: snapshot?.t, series: snapshot?.series }, day);
    count++;
  }
  console.log(`${day}: ${count} archived minutes scanned`);
}

const rows = [];
for (const card of cards) {
  const marks = best.get(`${keyOf(card)}|${card.date}`) ?? [];
  const reach = HORIZONS.map(horizon => {
    const high = Math.max(0, ...marks.slice(0, horizon));
    return high > 0 ? (high / card.entry - 1) * 100 : null;
  });
  rows.push({ symbol: card.symbol, contract: `${card.strike}${card.side}`, date: card.date, side: card.side, entry: card.entry, reachPct: reach });
}

const table = HORIZONS.map((horizon, index) => {
  const scored = rows.filter(row => row.reachPct[index] != null);
  const hits = Object.fromEntries(TARGETS.map(target => [target, scored.filter(row => row.reachPct[index] >= target).length]));
  return { horizon, scored: scored.length, hits };
});

console.log('\nReach by hold length (cards with a captured print in that window):');
for (const line of table) {
  const parts = TARGETS.map(target => `+${target}%: ${line.hits[target]}/${line.scored} (${line.scored ? Math.round(line.hits[target] / line.scored * 100) : 0}%)`);
  console.log(`  ${line.horizon} session(s) → ${parts.join(' · ')}`);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, horizons: HORIZONS, table, rows }, null, 2));
console.log(`\nreport → ${path.relative(ROOT, OUT)}`);