/**
 * Futures accumulator — fold our own daily capture into the futures store.
 *
 *   node scripts/accumulateFutures.mjs [date…]
 *
 * The bhavcopy is official but publishes a day late; our capture already holds
 * today's futures minute candles. This turns each captured session into one
 * daily row (day O/H/L/C, last OI, prev close) and appends it to
 * server/data/fut-daily/<SYM>.json without ever overwriting a bhavcopy row.
 *
 * Run it after the close (or at boot) so the futures distribution keeps growing
 * even when NSE has not published yet.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = path.join(ROOT, 'server', 'data', 'dhan');
const OUT = path.join(ROOT, 'server', 'data', 'fut-daily');

const args = process.argv.slice(2);
const dates = args.length ? args : readdirSync(CAPTURE).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
mkdirSync(OUT, { recursive: true });

let added = 0;
let sessions = 0;
for (const date of dates) {
  const dir = path.join(CAPTURE, date, 'futures');
  if (!existsSync(dir)) continue;
  sessions++;
  for (const file of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const symbol = file.replace(/\.json$/, '');
    let snapshot;
    try { snapshot = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const month = Array.isArray(snapshot?.months) ? snapshot.months[0] : null;
    const candles = (month?.candles ?? []).filter(c => Number.isFinite(c?.close) && c.close > 0);
    if (candles.length < 30) continue; // a partial session is not a daily bar
    const row = {
      date,
      expiry: month.date ?? null,
      open: candles[0].open ?? candles[0].close,
      high: Math.max(...candles.map(c => c.high ?? c.close)),
      low: Math.min(...candles.map(c => c.low ?? c.close)),
      close: candles[candles.length - 1].close,
      prevClose: month.prevClose ?? null,
      settle: null,
      underlying: null,
      oi: candles[candles.length - 1].oi ?? 0,
      oiChange: Number.isFinite(month.prevOi) ? (candles[candles.length - 1].oi ?? 0) - month.prevOi : 0,
      volume: candles.reduce((sum, c) => sum + (Number(c.volume) || 0), 0),
      source: 'capture',
    };
    const target = path.join(OUT, `${symbol}.json`);
    let store = { symbol, instrument: 'FUT', source: 'NSE F&O bhavcopy + own capture', rows: [] };
    if (existsSync(target)) {
      try { store = JSON.parse(readFileSync(target, 'utf8')); } catch { /* rebuild */ }
    }
    if (store.rows.some(item => item.date === date)) continue; // bhavcopy wins
    store.rows.push(row);
    store.rows.sort((a, b) => a.date.localeCompare(b.date));
    store.updatedAt = new Date().toISOString();
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, target);
    added++;
  }
}
console.log(`${sessions} captured sessions scanned · ${added} daily futures rows added → server/data/fut-daily/`);