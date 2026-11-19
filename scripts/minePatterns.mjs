/**
 * Pattern miner over the owner's 1-minute CSV history (offline, streaming).
 *
 *   node --max-old-space-size=6144 scripts/minePatterns.mjs TITAN [5,15,30,60] [lookback] [horizon] [targetPct]
 *
 * Reads <ROOT>/<SYM>-EQ/<SYM>-EQ1.csv (no header: date,time,open,high,low,close,volume),
 * resamples to each timeframe, and reports which 3-bar "DNA" sequences were
 * followed by a +X% or −X% move — learned on years up to 2023 and checked on
 * 2024 onward, so an in-sample-only pattern is visible as such.
 */
import { openSync, readSync, closeSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resample, minePatterns, rankPatterns } from '../server/patternMine.mjs';

const HISTORY_ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';
const OUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'data', 'patterns');
const args = process.argv.slice(2);
const symbol = (args[0] ?? 'TITAN').toUpperCase();
const timeframes = (args[1] ?? '5,15,30,60').split(',').map(Number).filter(n => n > 0);
const lookback = Number(args[2]) || 3;
const horizon = Number(args[3]) || 3;
const targetPct = Number(args[4]) || 1;
const splitAt = process.env.PATTERN_SPLIT ?? '2024.01.01';
const alphabet = process.env.PATTERN_ALPHABET ?? 'full';
const minSamples = Number(process.env.PATTERN_MIN_SAMPLES) || 150;

const file = path.join(HISTORY_ROOT, `${symbol}-EQ`, `${symbol}-EQ1.csv`);
if (!existsSync(file)) {
  console.error(`no history file for ${symbol}: ${file}`);
  process.exit(1);
}

/** Stream the CSV into session-tagged 1-minute bars. */
function loadBars() {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let pos = 0;
  let carry = '';
  const bars = [];
  let skipped = 0;
  const take = line => {
    if (!line.trim()) return;
    const f = line.split(',');
    if (f.length !== 7) { skipped++; return; }
    const [date, time, open, high, low, close, volume] = f;
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) { skipped++; return; }
    const at = Date.parse(`${date.replace(/\./g, '-')}T${time}:00+05:30`);
    const c = Number(close);
    if (!Number.isFinite(at) || !(c > 0)) { skipped++; return; }
    // Only regular-session minutes: stray evening prints are not tradeable bars.
    const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (minutes < 9 * 60 + 15 || minutes > 15 * 60 + 30) { skipped++; return; }
    bars.push({ at, session: date, open: Number(open), high: Number(high), low: Number(low), close: c, volume: Number(volume) || 0 });
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
  return { bars, skipped };
}

const { bars, skipped } = loadBars();
const sessions = new Set(bars.map(bar => bar.session));
console.log(`${symbol}: ${bars.length.toLocaleString()} session minutes, ${sessions.size} days, ${skipped} rows skipped`);
console.log(`lookback ${lookback} bars · horizon ${horizon} bars · target ±${targetPct}% · learn < ${splitAt} · check ≥ ${splitAt}\n`);

const report = { symbol, generatedAt: new Date().toISOString(), lookback, horizon, targetPct, splitAt, alphabet, minSamples, minutes: bars.length, days: sessions.size, timeframes: [] };

for (const tf of timeframes) {
  // Session tag comes from the IST date, not the UTC ISO date.
  const resampled = resample(bars, tf).map(bar => ({ ...bar, session: new Date(bar.at + 19_800_000).toISOString().slice(0, 10).replace(/-/g, '.') }));
  const mined = minePatterns(resampled, { lookback, horizon, targetPct, splitAt, alphabet });
  const ranked = rankPatterns(mined, { minSamples });
  const baseTrain = mined.base.train;
  const baseUp = baseTrain.n ? baseTrain.up / baseTrain.n : 0;
  const baseDown = baseTrain.n ? baseTrain.down / baseTrain.n : 0;
  const bt = mined.base.test;
  const testBaseUp = bt.n ? bt.up / bt.n : 0;
  const testBaseDown = bt.n ? bt.down / bt.n : 0;
  console.log(`── ${tf}m · ${resampled.length.toLocaleString()} bars · baseline ±${targetPct}%: learn ${(baseUp * 100).toFixed(1)}% up / ${(baseDown * 100).toFixed(1)}% down (n=${baseTrain.n}) · 2024+ ${(testBaseUp * 100).toFixed(1)}% up / ${(testBaseDown * 100).toFixed(1)}% down (n=${bt.n})`);
  for (const row of ranked.slice(0, 8)) {
    const testBase = row.direction === 'up' ? testBaseUp : testBaseDown;
    const edge = row.testSamples ? `${((row.testHitRate / (testBase || 1))).toFixed(2)}x baseline` : 'no test';
    const test = row.testSamples ? `${(row.testHitRate * 100).toFixed(1)}% (n=${row.testSamples}, ${edge})` : 'no test samples';
    console.log(`   ${row.pattern}  → ${row.direction.toUpperCase()} ${(row.hitRate * 100).toFixed(1)}% [floor ${(row.floor * 100).toFixed(1)}%, n=${row.samples}] · 2024+ ${test}`);
  }
  report.timeframes.push({ minutes: tf, bars: resampled.length, baseline: { up: baseUp, down: baseDown, n: baseTrain.n }, testBaseline: { up: testBaseUp, down: testBaseDown, n: bt.n }, top: ranked.slice(0, 25) });
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(report, null, 2));
console.log(`\nreport → server/data/patterns/${symbol}.json`);