/** Full per-signal accuracy table over persisted observation cards (read-only). */
import { readFileSync } from 'node:fs';
import { signalStats } from '../server/journalStats.mjs';

const [, , fromDate, toDate] = process.argv;
const obs = JSON.parse(readFileSync(new URL('../server/data/observations.json', import.meta.url), 'utf8'));
const cards = (obs.cards ?? obs).filter(card => {
  if (typeof card?.date !== 'string') return false;
  if (fromDate && card.date < fromDate) return false;
  if (toDate && card.date > toDate) return false;
  return true;
});

const stats = signalStats(cards);
if (!stats.length) { console.log('no cards in range'); process.exit(0); }
const pct = value => (value == null ? '—' : `${Math.round(value * 100)}%`);
const r = value => (value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`);
console.log(`cards ${cards.length} · buckets ${stats.length}`);
for (const item of stats) {
  console.log([item.label.padEnd(22), `cards ${String(item.cards).padStart(3)}`, `resolved ${String(item.resolved).padStart(3)}`, `TGT1 ${String(item.tgt1).padStart(3)}`, `SL ${String(item.sl).padStart(3)}`, `amb ${String(item.ambiguous).padStart(2)}`, `open ${String(item.open).padStart(2)}`, `win ${pct(item.winRate).padStart(4)}`, `avgR ${r(item.avgR)}`].join(' · '));
}