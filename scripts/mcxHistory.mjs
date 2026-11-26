/**
 * MCX futures daily history — MCX_FULL_SPEC C3.
 *
 *   node --env-file=.env scripts/mcxHistory.mjs            # all 6 MCX futures
 *   node --env-file=.env scripts/mcxHistory.mjs GOLD SILVER
 *
 * Pulls daily OHLC candles for the CURRENT near-month FUTCOM contracts from
 * Dhan POST /charts/historical (MCX_COMM + FUTCOM; instrument must be the real
 * name or Dhan answers DH-905), merges rows into server/data/fut-daily/<SYM>.json
 * in the same shape fetchBhavcopy produces, then lets scripts/ingestFutStats.mjs
 * compute the percentiles exactly like NSE futures (reuse-first rulebook).
 *
 * Output store rows carry source 'Dhan charts/historical (MCX_COMM)' so the
 * ingest tags the stats instrument: 'MCX-FUT'.
 *
 * REST-only: this script never touches the WebSocket feed.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(ROOT, 'data', '.dhan-master.csv');
const OUT = path.join(ROOT, 'server', 'data', 'fut-daily');
const SYMBOLS = (process.argv.slice(2).length ? process.argv.slice(2) : ['GOLD', 'SILVER', 'NATURALGAS', 'GOLDM', 'SILVERM', 'NATURALGASM']).map(s => s.toUpperCase());
const FROM = process.env.MCX_HISTORY_FROM ?? '2023-01-01';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const { loadDhanEnv, dhanChartsHistorical } = await import(path.join(ROOT, 'server', 'dhanRest.mjs'));
const env = loadDhanEnv();

const MASTER_ALIASES = { NATURALGASM: 'NATGASMINI' };

function currentFutcomId(symbol) {
  // Near-month FUTCOM row: EXACT base-symbol match before the first '-'.
  // startsWith here grabbed GOLDGUINEA for GOLD and SILVERM for SILVER — the
  // master is full of such prefixes. NATURALGASM trades as NATGASMINI.
  const base = MASTER_ALIASES[symbol] ?? symbol;
  const rows = readFileSync(MASTER, 'utf8').split('\n').filter(Boolean);
  const today = TODAY.replaceAll('-', '.');
  let best = null;
  for (const line of rows) {
    const c = line.split(',');
    if (c[0] !== 'MCX' || c[3] !== 'FUTCOM') continue;
    if ((c[5] ?? '').split('-')[0] !== base) continue;
    const expiry = (c[8] ?? '').slice(0, 10).replaceAll('-', '.');
    if (!expiry || expiry < today) continue;
    if (!best || expiry < best.expiry) best = { id: c[2], expiry, trade: c[5] };
  }
  return best;
}

function normalizeDate(iso) {
  // Dhan returns ISO 'YYYY-MM-DD'; the fut-daily store keys rows 'YYYY.MM.DD'.
  return iso.slice(0, 10).replaceAll('-', '.');
}

mkdirSync(OUT, { recursive: true });
let done = 0;
for (const symbol of SYMBOLS) {
  const contract = currentFutcomId(symbol);
  if (!contract) { console.log(`${symbol}: no active FUTCOM row in master — skipped`); continue; }
  try {
    const raw = await dhanChartsHistorical(env, { securityId: contract.id, exchangeSegment: 'MCX_COMM', instrument: 'FUTCOM', expiryCode: 0, oi: true, fromDate: FROM, toDate: TODAY.replaceAll('-', '-') });
    const opens = raw?.open ?? [];
    const n = opens.length;
    if (!n) { console.log(`${symbol}: no historical candles (contract ${contract.id} exp ${contract.expiry})`); continue; }
    const rows = [];
    for (let i = 0; i < n; i++) {
      const date = normalizeDate(new Date(raw.timestamp[i] * 1000).toISOString());
      const open = Number(raw.open[i]), high = Number(raw.high[i]), low = Number(raw.low[i]), close = Number(raw.close[i]);
      if (!(close > 0) || !(high > 0) || !(low > 0)) continue;
      rows.push({ date, open, high, low, close, oi: Number(raw.open_interest?.[i] ?? 0) });
    }
    const file = path.join(OUT, `${symbol}.json`);
    const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { symbol, source: 'Dhan charts/historical (MCX_COMM)', rows: [] };
    const byDate = new Map(store.rows.map(r => [r.date, r]));
    for (const r of rows) byDate.set(r.date, { ...byDate.get(r.date), ...r });
    store.rows = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    store.source = 'Dhan charts/historical (MCX_COMM)';
    store.contract = contract.trade;
    writeFileSync(file, JSON.stringify(store));
    console.log(`${symbol}: ${rows.length} daily rows (contract ${contract.trade} exp ${contract.expiry}) → fut-daily total ${store.rows.length}`);
    done++;
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) {
    console.error(`${symbol}: FAIL ${e.message}`);
  }
}
console.log(`${done}/${SYMBOLS.length} MCX futures histories fetched. Next: node scripts/ingestFutStats.mjs ${SYMBOLS.join(' ')}`);
