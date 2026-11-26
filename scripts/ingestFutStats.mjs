/**
 * Futures move statistics — the instrument the BOARD actually trades.
 *
 *   node scripts/ingestFutStats.mjs            # every stored symbol
 *   node scripts/accumulateFutures.mjs         # first, to add our own capture
 *
 * Source: server/data/fut-daily/<SYM>.json — NSE F&O bhavcopy daily futures
 * OHLC (plus our own captured sessions). Equity percentiles must never be
 * reused here: futures carry basis and can be materially more volatile.
 *
 * Produces the same shape as the equity move-stats (holds × percentiles ×
 * regime) so the level policy can read either, but tags instrument: 'FUT'.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regimeOf, REGIMES } from '../server/moveRegime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server', 'data', 'fut-daily');
const OUT = path.join(ROOT, 'server', 'data', 'fut-stats');
const HOLDS = [1, 2, 3, 5, 10];
const PERCENTILES = [10, 20, 30, 50, 70, 85, 95, 98, 99];
const RECENT_FROM = process.env.FUT_STATS_RECENT ?? '2024.01.01';
const MIN_DAYS = Number(process.env.FUT_STATS_MIN_DAYS ?? 40);

const args = process.argv.slice(2).map(a => a.toUpperCase());
if (!existsSync(SRC)) { console.error('no fut-daily store — run scripts/fetchBhavcopy.mjs first'); process.exit(1); }
const symbols = args.length ? args : readdirSync(SRC).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, ''));

function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const out = { n: sorted.length };
  for (const p of PERCENTILES) out[`p${p}`] = Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(3));
  out.max = Number(sorted[sorted.length - 1].toFixed(3));
  return out;
}

mkdirSync(OUT, { recursive: true });
let done = 0;
for (const symbol of symbols) {
  const file = path.join(SRC, `${symbol}.json`);
  if (!existsSync(file)) continue;
  let store;
  try { store = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
  const rows = (store.rows ?? []).filter(r => r.close > 0 && r.high > 0 && r.low > 0);
  if (rows.length < MIN_DAYS) { console.log(`${symbol}: only ${rows.length} futures sessions, skipped`); continue; }
  const closes = rows.map(r => r.close);
  const regimes = rows.map((_, i) => regimeOf(closes, i));
  const daily = {};
  for (const hold of HOLDS) {
    const cell = { all: { up: [], down: [] }, recent: { up: [], down: [] }, byRegime: Object.fromEntries(REGIMES.map(r => [r, { up: [], down: [] }])) };
    for (let i = 0; i + hold < rows.length; i++) {
      const base = closes[i];
      let hi = base;
      let lo = base;
      for (let k = i + 1; k <= i + hold; k++) {
        if (rows[k].high > hi) hi = rows[k].high;
        if (rows[k].low < lo) lo = rows[k].low;
      }
      const up = (hi / base - 1) * 100;
      const down = (1 - lo / base) * 100;
      cell.all.up.push(up); cell.all.down.push(down);
      if (rows[i].date >= RECENT_FROM) { cell.recent.up.push(up); cell.recent.down.push(down); }
      cell.byRegime[regimes[i]].up.push(up); cell.byRegime[regimes[i]].down.push(down);
    }
    daily[hold] = {
      all: { up: percentiles(cell.all.up), down: percentiles(cell.all.down) },
      recent: { up: percentiles(cell.recent.up), down: percentiles(cell.recent.down) },
      byRegime: Object.fromEntries(REGIMES.map(r => [r, { up: percentiles(cell.byRegime[r].up), down: percentiles(cell.byRegime[r].down) }])),
    };
  }
  writeFileSync(path.join(OUT, `${symbol}.json`), JSON.stringify({
    symbol,
    instrument: /MCX/.test(store.source ?? '') ? 'MCX-FUT' : 'FUT',
    source: store.source ?? 'NSE F&O bhavcopy',
    generatedAt: new Date().toISOString(),
    days: rows.length,
    from: rows[0].date,
    to: rows[rows.length - 1].date,
    recentFrom: RECENT_FROM,
    holds: HOLDS,
    percentiles: PERCENTILES,
    regimes: REGIMES,
    recentCloses: rows.slice(-40).map(r => ({ date: r.date, close: r.close })),
    lastRegime: regimes[regimes.length - 1],
    daily,
  }));
  done++;
}
console.log(`${done}/${symbols.length} futures stats written → server/data/fut-stats/`);