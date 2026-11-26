/**
 * Re-stamp same-`at` card clusters into their true creation order using the
 * launchd log's recorded telegram send times (owner-approved 2026-11-26).
 * Cluster base time is preserved; members get +index ms in send order.
 * Cards with no log line keep their position after the sent ones.
 *
 *   node scripts/restampCards.mjs [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.OBS_STORE ?? join(ROOT, 'server', 'data', 'observations.json');
const LOG = join(ROOT, 'server', 'data', 'logs', 'order-flow.launchd.out.log');
const dry = process.argv.includes('--dry');

// Recorded send times: "2026-11-26T04:01:45.532Z telegram sent: observation ENRIN 3100CE"
const sendTime = new Map();
for (const line of readFileSync(LOG, 'utf8').split('\n')) {
  const m = line.match(/^(2026-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) telegram sent: observation (\S+) (\d[\d.]*)(CE|PE)\b/);
  if (m) sendTime.set(`${m[2]}|${m[3]}${m[4]}`, Date.parse(m[1]));
}

const store = JSON.parse(readFileSync(STORE, 'utf8'));
const cards = Array.isArray(store.cards) ? store.cards : [];

// Cluster by exact at (only same-ms groups need re-stamping).
const clusters = new Map();
cards.forEach((card, index) => {
  clusters.set(card.at, [...(clusters.get(card.at) ?? []), index]);
});

let restamped = 0;
for (const [at, indexes] of clusters) {
  if (indexes.length < 2) continue;
  const ordered = indexes.map(index => {
    const c = cards[index];
    const t = sendTime.get(`${c.symbol}|${c.strike}${c.side}`);
    return { index, t: t == null ? Number.POSITIVE_INFINITY : t };
  }).sort((a, b) => a.t - b.t);
  ordered.forEach(({ index }, position) => {
    const newAt = at + position;
    if (cards[index].at !== newAt) { cards[index].at = newAt; restamped++; }
  });
}

if (dry) { console.log(`would re-stamp ${restamped} cards`); process.exit(0); }
copyFileSync(STORE, `${STORE}.bak-restamp-${Date.now()}`);
writeFileSync(STORE, JSON.stringify(store));
console.log(`re-stamped ${restamped} cards across ${clusters.size} timestamps (backup saved)`);
