// retrySparseBackfill — past-date futures gap fill for symbols whose /charts/intraday failed
// during 429 storms. Fetches per symbol from Dhan charts/intraday for the given session and
// merges field-level into the persisted capture file (feed close/OI win over REST).
//   node scripts/retrySparseBackfill.mjs 2026-11-23 SYM1,SYM2,...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTodayIntraday } from '../server/providers/dhan.mjs';
import { loadDhanEnv, dhanChartsIntraday, nearMonthFuturesId } from '../server/dhanRest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const [, , session, list] = process.argv;
const symbols = (list || '').split(',').map(s => s.trim()).filter(Boolean);
if (!session || !symbols.length) { console.error('usage: retrySparseBackfill.mjs <date> SYM1,SYM2'); process.exit(1); }

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').map(l => {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); return m ? [m[1], m[2]] : [null, null];
}).filter(r => r[0]));
const HEADERS = { 'access-token': env.DHAN_ACCESS_TOKEN, 'client-id': env.DHAN_CLIENT_ID, 'Content-Type': 'application/json', 'Accept': 'application/json' };

// near-month futures securityId per symbol from the cached master
const masterRows = fs.readFileSync(path.join(ROOT, 'data', '.dhan-master.csv'), 'utf8').split('\n');
const futId = new Map();
for (const row of masterRows) {
  const c = row.split(',');
  const exch = (c[0] || '').trim();
  if (exch !== 'NSE' && exch !== 'BSE') continue;
  const seg = (c[1] || '').trim();
  const instr = (c[3] || '').trim();
  const tsym = (c[5] || '').trim().toUpperCase();
  if (seg !== 'D' || instr !== 'FUTSTK' && instr !== 'FUTIDX' || !tsym.endsWith('-FUT')) continue;
  const hyphen = tsym.lastIndexOf('-');
  const base = tsym.slice(0, tsym.lastIndexOf('-', hyphen - 1));
  const exp = (c[8] || '').slice(0, 10);
  if (!base || !exp || exp < session) continue;
  const id = (c[2] || '').trim();
  if (!id) continue;
  const rec = { id, exp, seg: exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO', instrument: instr };
  const cur = futId.get(base);
  if (!cur || (cur.seg === 'BSE_FNO' && rec.seg === 'NSE_FNO') || (rec.exp < cur.exp)) futId.set(base, rec);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let updated = 0, failed = 0, noId = 0;
const failedList = [];
for (const sym of symbols) {
  const fut = nearMonthFuturesId(env, sym, session);
  if (!fut) { console.log(`${sym}: no near-month futures id in master`); noId++; failedList.push(sym); continue; }
  try {
    const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ securityId: fut.id, exchangeSegment: fut.seg, instrument: fut.instrument || 'FUTSTK', interval: 1, oi: true, fromDate: session, toDate: session }),
    });
    const raw = await res.json();
    const payload = 'status' in raw ? raw.data : raw;
    const candles = parseTodayIntraday(payload, session).filter(c => Number.isFinite(c.at) && c.close > 0);
    const file = path.join(ROOT, 'server', 'data', 'dhan', session, 'futures', `${sym}.json`);
    if (!candles.length) { console.log(`${sym}: REST returned 0 candles`); failedList.push(sym); continue; }
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    persisted.months ??= [{ candles: [] }];
    const store = persisted.months[0].candles;
    const byAt = new Map(store.map(c => [c.at, c]));
    for (const c of candles) {
      const cur = byAt.get(c.at);
      if (!cur) { byAt.set(c.at, { ...c }); continue; }
      cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low);
      if (Number.isFinite(c.open)) cur.open ??= c.open;
    }
    const before = store.length;
    persisted.months[0].candles = [...byAt.values()].sort((a, b) => a.at - b.at);
    fs.writeFileSync(file, JSON.stringify(persisted));
    console.log(`${sym}: disk ${before} → ${byAt.size} candles (REST ${candles.length})`);
    updated++;
  } catch (e) { console.log(`${sym}: FAIL ${e.message}`); failedList.push(sym); }
  await sleep(1200);
}
console.log(`\nupdated: ${updated} · failed/no-id: ${failed + noId}${failedList.length ? ' · ' + failedList.join(',') : ''}`);
