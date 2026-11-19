/**
 * NSE F&O bhavcopy → a daily FUTURES store.
 *
 *   node scripts/fetchBhavcopy.mjs 2026-05-01 2026-11-18
 *
 * Brokers do not sell 1-minute futures history, but NSE publishes the official
 * daily F&O bhavcopy: every futures contract's open/high/low/close, settle,
 * previous close, underlying price and open interest. That is enough for the
 * multi-day move distributions the board's futures signals need — the equity
 * CSV can only serve the spot-settled option cards.
 *
 * Idempotent: a date already stored is skipped. Holidays 404 and are skipped.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'data', 'fut-daily');
const TMP = path.join(ROOT, 'server', 'data', '.bhavcopy-tmp');
const HOSTS = ['https://nsearchives.nseindia.com', 'https://archives.nseindia.com'];
const PAUSE_MS = Number(process.env.BHAVCOPY_PAUSE_MS ?? 350);

const args = process.argv.slice(2);
const to = args[1] ?? new Date().toISOString().slice(0, 10);
const from = args[0] ?? new Date(Date.parse(`${to}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ymd = date => date.replace(/-/g, '');

/** UDiFF column positions (1-indexed in the CSV, 0-indexed here). */
const COL = { date: 0, type: 4, symbol: 7, expiry: 9, open: 14, high: 15, low: 16, close: 17, prevClose: 19, underlying: 20, settle: 21, oi: 22, oiChange: 23, volume: 24 };

async function download(date) {
  const name = `BhavCopy_NSE_FO_0_0_0_${ymd(date)}_F_0000.csv.zip`;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/content/fo/${name}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*', Referer: 'https://www.nseindia.com/' },
      });
      if (res.status === 404) return null; // holiday / not published
      if (!res.ok) continue;
      const zip = path.join(TMP, name);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const csv = execFileSync('unzip', ['-p', zip], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
      return csv;
    } catch { /* try the next host */ }
  }
  return null;
}

function futuresRows(csv, date) {
  const lines = csv.split('\n');
  const bySymbol = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');
    const type = f[COL.type];
    if (type !== 'STF' && type !== 'IDF') continue;
    if (f[COL.date] !== date) continue;
    const symbol = f[COL.symbol];
    const expiry = f[COL.expiry];
    const close = Number(f[COL.close]);
    if (!symbol || !expiry || !(close > 0)) continue;
    const row = {
      date,
      expiry,
      open: Number(f[COL.open]) || null,
      high: Number(f[COL.high]) || null,
      low: Number(f[COL.low]) || null,
      close,
      prevClose: Number(f[COL.prevClose]) || null,
      settle: Number(f[COL.settle]) || null,
      underlying: Number(f[COL.underlying]) || null,
      oi: Number(f[COL.oi]) || 0,
      oiChange: Number(f[COL.oiChange]) || 0,
      volume: Number(f[COL.volume]) || 0,
    };
    // Near month only: the contract the board actually tracks.
    const held = bySymbol.get(symbol);
    if (!held || row.expiry < held.expiry) bySymbol.set(symbol, row);
  }
  return bySymbol;
}

function append(symbol, row) {
  const file = path.join(OUT, `${symbol}.json`);
  let store = { symbol, instrument: 'FUT', source: 'NSE F&O bhavcopy', rows: [] };
  if (existsSync(file)) {
    try { store = JSON.parse(readFileSync(file, 'utf8')); } catch { /* rebuild a corrupt store */ }
  }
  if (store.rows.some(item => item.date === row.date)) return false;
  store.rows.push(row);
  store.rows.sort((a, b) => a.date.localeCompare(b.date));
  store.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, file);
  return true;
}

let fetched = 0;
let skipped = 0;
let holidays = 0;
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
  const date = new Date(t).toISOString().slice(0, 10);
  const weekday = new Date(t).getUTCDay();
  if (weekday === 0 || weekday === 6) continue;
  const marker = path.join(OUT, '.fetched', date);
  if (existsSync(marker)) { skipped++; continue; }
  const csv = await download(date);
  if (!csv) { holidays++; await sleep(PAUSE_MS); continue; }
  const rows = futuresRows(csv, date);
  let written = 0;
  for (const [symbol, row] of rows) if (append(symbol, row)) written++;
  mkdirSync(path.join(OUT, '.fetched'), { recursive: true });
  writeFileSync(marker, String(rows.size));
  fetched++;
  console.log(`${date}: ${rows.size} futures (${written} new rows)`);
  await sleep(PAUSE_MS);
}
console.log(`\n${fetched} sessions fetched, ${skipped} already stored, ${holidays} holidays/unavailable → server/data/fut-daily/`);