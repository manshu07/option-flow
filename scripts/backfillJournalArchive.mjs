// One-off offline backfill: resolve archived-date observation cards.
// Run with a big heap: node --max-old-space-size=8192 backfill.mjs <date> <archive.gz> <obsPath>
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolveCard } from '/Users/himanshuvaghela/emdash-projects/order-flow/server/journal.mjs';

const [date, archivePath, obsPath] = process.argv.slice(2);
if (!date || !archivePath || !obsPath) {
  console.error('usage: backfill.mjs <YYYY-MM-DD> <archive.gz> <observations.json>');
  process.exit(1);
}

const payload = JSON.parse(gunzipSync(fs.readFileSync(archivePath)).toString('utf8'));
const snapshots = Object.values(payload.minutes ?? {})
  .filter(snapshot => snapshot && typeof snapshot === 'object')
  .sort((a, b) => a.t - b.t);
console.log(`archive ${date}: ${snapshots.length} snapshots`);

const store = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
const cards = Array.isArray(store?.cards) ? store.cards : [];
let resolved = 0;

for (const card of cards) {
  if (card?.date !== date || card?.outcome) continue;
  const outcome = resolveCard(card, snapshots);
  if (!outcome) { console.log(' no outcome', card.symbol, card.strike + card.side); continue; }
  card.outcome = outcome;
  resolved += 1;
  console.log(` ${card.symbol} ${card.strike}${card.side} → ${outcome.status} r=${outcome.r} mfe=${outcome.mfe} mae=${outcome.mae}`);
}

if (resolved) {
  fs.writeFileSync(`${obsPath}.tmp`, JSON.stringify(store, null, 2));
  fs.renameSync(`${obsPath}.tmp`, obsPath);
}
console.log(`resolved ${resolved} card(s) for ${date}`);