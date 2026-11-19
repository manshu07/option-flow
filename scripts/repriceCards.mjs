/**
 * Re-price stored observation cards with the current level engine.
 *
 *   node --env-file-if-exists=.env scripts/repriceCards.mjs [date…] [--dry]
 *
 * Defaults to today and the previous captured session. Each card is priced AS
 * OF ITS OWN ISSUE TIME (its `at`), not now — otherwise DTE and theta would be
 * wrong for yesterday's cards.
 *
 * Nothing is thrown away: the old levels and the old outcome are kept on the
 * card as `priorLevels` / `priorOutcome`, and the outcome is cleared so the
 * journal regrades against the new levels on its next pass.
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptiveLevels } from '../server/strikeAdvisor.mjs';
import { loadMoveStats } from '../server/moveStats.mjs';
import { loadLevelGrid } from '../server/levelPolicy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OBS = path.join(ROOT, 'server', 'data', 'observations.json');
const STATS = path.join(ROOT, 'server', 'data', 'move-stats');
const GRID = path.join(ROOT, 'server', 'data', 'level-grid');
const CAPTURE = path.join(ROOT, 'server', 'data', 'dhan');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
const sessions = readdirSync(CAPTURE).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
const dates = explicit.length ? explicit : sessions.slice(-2);

const store = JSON.parse(readFileSync(OBS, 'utf8'));
const cards = store.cards ?? [];
console.log(`re-pricing dates: ${dates.join(', ')} · policy ${process.env.ADVISOR_LEVEL_POLICY ?? 'achievable'} · min R:R ${process.env.ADVISOR_MIN_RR ?? 2}`);

const summary = { repriced: 0, noEdge: 0, untouched: 0, byBasis: {} };
const rows = [];
const updated = cards.map(card => {
  if (!dates.includes(card.date)) { summary.untouched++; return card; }
  const now = Number.isFinite(card.at) ? card.at : Date.now();
  const priced = adaptiveLevels(card, {
    now,
    moveStats: loadMoveStats(STATS, card.symbol),
    levelGrid: loadLevelGrid(GRID, card.symbol),
  });
  const basis = priced.levelsBasis ?? 'fixed';
  summary.byBasis[basis] = (summary.byBasis[basis] ?? 0) + 1;
  if (basis === 'no-edge') summary.noEdge++;
  summary.repriced++;
  rows.push({
    symbol: card.symbol,
    contract: `${card.strike}${card.side}`,
    date: card.date,
    was: card.levelsBasis ?? 'fixed',
    now: basis,
    sl: priced.sl,
    tgt1: priced.tgt1,
    win: priced.backtest ? `${Math.round(priced.backtest.winRate * 100)}%` : '—',
    rr: priced.backtest?.rewardRisk ?? '—',
    reason: priced.levelsRejected ?? '',
  });
  const next = {
    ...priced,
    // Keep the historical record: what was quoted, and how it had been graded.
    priorLevels: card.priorLevels ?? { sl: card.sl, tgt1: card.tgt1, tgt2: card.tgt2, levelsBasis: card.levelsBasis ?? 'fixed' },
    repricedAt: Date.now(),
  };
  if (card.outcome) {
    next.priorOutcome = card.priorOutcome ?? card.outcome;
    delete next.outcome; // the journal regrades against the new levels
    delete next.marks;
  }
  return next;
});

for (const row of rows) {
  console.log(`${row.date} ${row.symbol.padEnd(12)} ${row.contract.padEnd(9)} ${row.was.padEnd(14)} → ${row.now.padEnd(14)} SL ${String(row.sl).padEnd(8)} TGT1 ${String(row.tgt1).padEnd(8)} win ${row.win.padEnd(4)} RR ${row.rr}${row.reason ? '  (' + row.reason.slice(0, 70) + ')' : ''}`);
}
console.log('\nsummary', JSON.stringify(summary));

if (dry) { console.log('(--dry: nothing written)'); process.exit(0); }
const backup = `${OBS}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
copyFileSync(OBS, backup);
const tmp = `${OBS}.tmp`;
writeFileSync(tmp, JSON.stringify({ ...store, cards: updated }, null, 2));
renameSync(tmp, OBS);
console.log(`written · backup ${path.basename(backup)}`);