// refixTodayCards — offline (post-close): re-price a session's cards with the CURRENT
// adaptiveLevels (degenerate-level guard live) and resolve their outcome from the captured
// raw minutes. Built for the 2026-11-23 index cards that shipped SL 0.05 / TGT1 12x.
//
//   node scripts/refixTodayCards.mjs 2026-11-23 [--apply]
// Dry-run by default: prints old/new levels and the resolved status without writing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptiveLevels } from '../server/strikeAdvisor.mjs';
import { resolveCard, trackCardFollowThrough, withJournalStoreLock } from '../server/journal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , date = '2026-11-23', flag] = process.argv;
const apply = flag === '--apply';
const dataDir = path.join(HERE, '..', 'server', 'data');
const rawDir = path.join(dataDir, 'dhan', date);
const obsPath = path.join(dataDir, 'observations.json');

if (!fs.statSync(rawDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`no raw minute dir for ${date} (${rawDir})`);
  process.exit(1);
}
const snaps = fs.readdirSync(rawDir).filter(f => /^\d{4}\.json$/.test(f)).sort().map(f => {
  try { return JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch { return null; }
}).filter(s => s && s.date === date && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
console.log(`${date}: ${snaps.length} captured snapshots`);

const store = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
const targets = (store.cards ?? []).filter(c => c.date === date);
console.log(`cards to review: ${targets.length}`);

let changed = 0;
const report = [];
for (const card of targets) {
  const repriced = adaptiveLevels(card);
  const re = { ...card, sl: repriced.sl, tgt1: repriced.tgt1, tgt2: repriced.tgt2, levelsBasis: repriced.levelsBasis };
  const followThrough = trackCardFollowThrough(re, snaps, { source: 'raw' });
  const legacy = resolveCard(re, snaps);
  const outcome = followThrough ? { ...(legacy ?? { status: 'open', r: null }), followThrough } : card.outcome;
  const levelsChanged = repriced.sl !== card.sl || repriced.tgt1 !== card.tgt1;
  const statusChanged = (outcome?.status ?? 'open') !== (card.outcome?.status ?? 'open');
  if (levelsChanged || statusChanged) changed++;
  report.push({
    id: card.id, symbol: card.symbol, side: card.side, strike: card.strike,
    entry: card.entry,
    old: { sl: card.sl, tgt1: card.tgt1, tgt2: card.tgt2, status: card.outcome?.status ?? 'open', basis: card.levelsBasis },
    new: { sl: re.sl, tgt1: re.tgt1, tgt2: re.tgt2, status: outcome?.status ?? 'open', basis: re.levelsBasis, r: outcome?.r ?? null, sequence: followThrough?.sequence ?? null, sampleCount: followThrough?.sampleCount ?? 0 },
  });
}
for (const r of report) console.log(JSON.stringify(r));
console.log(`\ncards needing update: ${changed} · mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

if (apply) {
  const byId = new Map(report.map((r, i) => [targets[i].id, targets[i]]));
  withJournalStoreLock(obsPath, () => {
    const current = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
    current.cards = current.cards.map(card => {
      if (card.date !== date) return card;
      const repriced = adaptiveLevels(card);
      const re = { ...card, sl: repriced.sl, tgt1: repriced.tgt1, tgt2: repriced.tgt2, levelsBasis: repriced.levelsBasis };
      const followThrough = trackCardFollowThrough(re, snaps, { source: 'raw' });
      const legacy = resolveCard(re, snaps);
      const outcome = followThrough ? { ...(legacy ?? { status: 'open', r: null }), followThrough } : card.outcome;
      return { ...card, sl: re.sl, tgt1: re.tgt1, tgt2: re.tgt2, levelsBasis: re.levelsBasis, outcome };
    });
    fs.writeFileSync(obsPath, JSON.stringify(current));
    return true;
  });
  console.log('store written.');
}
