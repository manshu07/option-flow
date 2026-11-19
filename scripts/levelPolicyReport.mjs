/**
 * Policy coverage report — across every ingested symbol, how often does a
 * target/stop pair exist that is BOTH achievable (target first ≥70%, stop
 * first ≤20%) and payable (≥1:2 in premium after decay)?
 *
 *   node scripts/levelPolicyReport.mjs [holdDays] [dte] [iv]
 *
 * Prices a representative at-the-money option so the reward:risk test is in
 * premium terms, not underlying points. This is the honest answer to "can every
 * card have an achievable target?" — it counts where the answer is yes.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLevelGrid, cellFor, pickPairForStrike } from '../server/levelPolicy.mjs';
import { bsPrice } from '../server/optionMath.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRID = path.join(ROOT, 'server', 'data', 'level-grid');
const hold = Number(process.argv[2]) || 2;
const dte = Number(process.argv[3]) || 30;
const iv = Number(process.argv[4]) || 0.25;
const years = dte / 365;
const spot = 100;
const strike = 100;
const entry = bsPrice({ spot, strike, years, iv, side: 'CE' });

const files = readdirSync(GRID).filter(name => name.endsWith('.json'));
const rows = [];
let yes = 0;
let no = 0;
const reasons = new Map();
for (const file of files) {
  const symbol = file.replace(/\.json$/, '');
  const grid = loadLevelGrid(GRID, symbol);
  for (const regime of ['up', 'down', 'range']) {
    for (const side of ['CE', 'PE']) {
      const cell = cellFor({ grid, holdDays: hold, regime, side });
      if (!cell) continue;
      const chosen = pickPairForStrike({ cell, spot, strike, entry, years, iv, side, days: hold, wall: null });
      if (chosen.pair) {
        yes++;
        rows.push({ symbol, regime, side, ...chosen.pair, expectancyPremium: chosen.priced.expectancyPremium });
      } else {
        no++;
        const key = (chosen.reason ?? 'unknown').split(' — ')[0];
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
  }
}

console.log(`ATM ${dte} DTE, IV ${(iv * 100).toFixed(0)}%, hold ${hold} sessions · ${files.length} symbols`);
console.log(`Setups with an achievable AND ≥1:2 pair: ${yes} / ${yes + no} (${((yes / (yes + no)) * 100).toFixed(1)}%)`);
console.log('Why the rest fail:');
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${count}× ${reason}`);

const byRegime = {};
for (const row of rows) {
  const key = `${row.regime}/${row.side}`;
  byRegime[key] = (byRegime[key] ?? 0) + 1;
}
console.log('Qualifying setups by regime/side:', byRegime);

const best = rows.sort((a, b) => b.expectancyPremium - a.expectancyPremium).slice(0, 10);
console.log('\nBest qualifying setups (rupee expectancy on a ₹' + entry.toFixed(2) + ' ATM premium):');
for (const row of best) {
  console.log(`  ${row.symbol.padEnd(12)} ${row.regime.padEnd(5)} ${row.side} · tgt ${row.targetPct}% stop ${row.stopPct}% · win ${(row.winRate * 100).toFixed(0)}% stop ${(row.lossRate * 100).toFixed(0)}% · 1:${row.rewardRisk.toFixed(2)} · ₹${row.expectancyPremium.toFixed(2)} · n=${row.samples}`);
}