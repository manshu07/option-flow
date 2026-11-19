/**
 * Move statistics from the owner's 1-minute equity history (offline, streaming).
 *
 *   node --max-old-space-size=6144 scripts/ingestMoveStats.mjs TITAN [more symbols…]
 *   node --max-old-space-size=6144 scripts/ingestMoveStats.mjs --all
 *
 * For every symbol it measures, from the CSV alone:
 *   - intraday: from each entry time to the session close, how far price went
 *     UP (favourable for a CE) and DOWN (favourable for a PE), as percentiles
 *   - multi-day: the same over the next 1/2/3/5/10 sessions from a day's close
 *
 * Both are reported for the full history and for the recent era, because
 * volatility drifts (TITAN's 2-day p70 fell from 2.45% to 1.89% after 2024).
 *
 * These are EQUITY (spot) statistics: stock options settle on spot, so they
 * size option-card levels. They are NOT futures statistics — the board's
 * futures signals need the futures history we capture ourselves.
 */
import { openSync, readSync, closeSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regimeOf, REGIMES, REGIME_LOOKBACK, REGIME_TREND_ER } from '../server/moveRegime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';
const OUT_DIR = path.join(ROOT, 'server', 'data', 'move-stats');
const RECENT_FROM = process.env.MOVE_STATS_RECENT ?? '2024.01.01';
const ENTRY_TIMES = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'];
const HOLDS = [1, 2, 3, 5, 10];
// p30 is the level 70% of past windows REACHED; p70 is reached by only 30%.
// p98/p99 exist for the stop: a level only 1-2% of windows ever breached.
const PERCENTILES = [10, 20, 30, 50, 70, 85, 95, 98, 99];

const args = process.argv.slice(2);
const all = args.includes('--all');
const symbols = (all
  ? readdirSync(HISTORY_ROOT).filter(name => name.endsWith('-EQ')).map(name => name.replace(/-EQ$/, ''))
  : args.filter(arg => !arg.startsWith('--')).map(arg => arg.toUpperCase()));
if (!symbols.length) {
  console.error('usage: node scripts/ingestMoveStats.mjs <SYMBOL…> | --all');
  process.exit(1);
}

/** Stream one symbol's CSV into per-session minute arrays. */
function loadDays(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let pos = 0;
  let carry = '';
  const days = new Map();
  let skipped = 0;
  const take = line => {
    if (!line.trim()) return;
    const f = line.split(',');
    if (f.length !== 7) { skipped++; return; }
    const [date, time, , high, low, close] = f;
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) { skipped++; return; }
    const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (minute < 9 * 60 + 15 || minute > 15 * 60 + 30) { skipped++; return; }
    const h = Number(high);
    const l = Number(low);
    const c = Number(close);
    if (!(c > 0) || !(h > 0) || !(l > 0)) { skipped++; return; }
    let day = days.get(date);
    if (!day) { day = { t: [], h: [], l: [], c: [] }; days.set(date, day); }
    day.t.push(time);
    day.h.push(h);
    day.l.push(l);
    day.c.push(c);
  };
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    pos += n;
    const text = carry + buf.toString('utf8', 0, n);
    const lines = text.split('\n');
    carry = lines.pop();
    for (const line of lines) take(line);
  }
  take(carry);
  closeSync(fd);
  return { days, skipped };
}

function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const out = { n: sorted.length };
  for (const p of PERCENTILES) out[`p${p}`] = Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(3));
  out.max = Number(sorted[sorted.length - 1].toFixed(3));
  return out;
}

const bucket = () => ({ up: [], down: [] });
const pushPair = (store, up, down) => { store.up.push(up); store.down.push(down); };
const summarise = store => ({ up: percentiles(store.up), down: percentiles(store.down) });

mkdirSync(OUT_DIR, { recursive: true });
let done = 0;
for (const symbol of symbols) {
  const file = path.join(HISTORY_ROOT, `${symbol}-EQ`, `${symbol}-EQ1.csv`);
  if (!existsSync(file)) { console.log(`${symbol}: no CSV, skipped`); continue; }
  const started = Date.now();
  const { days, skipped } = loadDays(file);
  const dates = [...days.keys()].sort();
  if (dates.length < 30) { console.log(`${symbol}: only ${dates.length} days, skipped`); continue; }

  const dayHigh = dates.map(date => Math.max(...days.get(date).h));
  const dayLow = dates.map(date => Math.min(...days.get(date).l));
  const dayClose = dates.map(date => { const c = days.get(date).c; return c[c.length - 1]; });
  const regimes = dates.map((_, i) => regimeOf(dayClose, i));

  // Every sample is stored twice: pooled, and under the regime known at entry.
  const cell = () => ({ all: { up: [], down: [] }, recent: { up: [], down: [] }, byRegime: Object.fromEntries(REGIMES.map(r => [r, { up: [], down: [] }])) });
  const add = (store, date, regime, up, down) => {
    store.all.up.push(up); store.all.down.push(down);
    if (date >= RECENT_FROM) { store.recent.up.push(up); store.recent.down.push(down); }
    store.byRegime[regime].up.push(up); store.byRegime[regime].down.push(down);
  };
  const summarise = store => ({
    all: { up: percentiles(store.all.up), down: percentiles(store.all.down) },
    recent: { up: percentiles(store.recent.up), down: percentiles(store.recent.down) },
    byRegime: Object.fromEntries(REGIMES.map(r => [r, { up: percentiles(store.byRegime[r].up), down: percentiles(store.byRegime[r].down) }])),
  });

  const intraday = {};
  for (const entry of ENTRY_TIMES) {
    const store = cell();
    for (let d = 0; d < dates.length; d++) {
      const day = days.get(dates[d]);
      const i = day.t.indexOf(entry);
      if (i < 0 || i >= day.c.length - 5) continue;
      const base = day.c[i];
      let hi = base;
      let lo = base;
      for (let k = i + 1; k < day.c.length; k++) {
        if (day.h[k] > hi) hi = day.h[k];
        if (day.l[k] < lo) lo = day.l[k];
      }
      add(store, dates[d], regimes[d], (hi / base - 1) * 100, (1 - lo / base) * 100);
    }
    intraday[entry] = summarise(store);
  }

  const daily = {};
  for (const hold of HOLDS) {
    const store = cell();
    for (let i = 0; i + hold < dates.length; i++) {
      const base = dayClose[i];
      if (!(base > 0)) continue;
      let hi = base;
      let lo = base;
      for (let k = i + 1; k <= i + hold; k++) {
        if (dayHigh[k] > hi) hi = dayHigh[k];
        if (dayLow[k] < lo) lo = dayLow[k];
      }
      add(store, dates[i], regimes[i], (hi / base - 1) * 100, (1 - lo / base) * 100);
    }
    daily[hold] = summarise(store);
  }

  const report = {
    symbol,
    instrument: 'EQ',
    source: path.basename(file),
    generatedAt: new Date().toISOString(),
    days: dates.length,
    from: dates[0],
    to: dates[dates.length - 1],
    recentFrom: RECENT_FROM,
    rowsSkipped: skipped,
    entryTimes: ENTRY_TIMES,
    holds: HOLDS,
    percentiles: PERCENTILES,
    regimes: REGIMES,
    regimeRule: { lookback: REGIME_LOOKBACK, trendEfficiency: REGIME_TREND_ER },
    // The last closes travel with the stats so the live card can classify
    // today's regime without re-reading 58 MB of CSV.
    recentCloses: dates.slice(-40).map((date, i, arr) => ({ date, close: dayClose[dates.length - arr.length + i] })),
    lastRegime: regimes[regimes.length - 1],
    intraday,
    daily,
  };
  writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(report));
  done++;
  const sample = daily[2]?.recent?.up;
  console.log(`${symbol}: ${dates.length} days · 2-day up p70 ${sample ? sample.p70 + '%' : 'n/a'} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`\n${done}/${symbols.length} symbols written to server/data/move-stats/`);