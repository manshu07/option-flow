// dhanRest.mjs — REST-ONLY Dhan client for offline scripts.
//
// GUARANTEE: this module contains NO WebSocket, NO feed connection, NO provider init.
// It cannot steal the live server's WS slots (see the 2026-11-24 connection-limit incident:
// an offline script that opened the full feed dropped the live server to 0/5 for ~30 min).
// Every offline/backfill script MUST import from here instead of createDhanProvider.
// Enforced by server/scriptsHygiene.test.ts.
//
// Exposes:
//   loadDhanEnv()                     → {DHAN_ACCESS_TOKEN, DHAN_CLIENT_ID, ...} from .env
//   dhanQuote(segments)               → POST /marketfeed/quote (raw json)
//   dhanChartsIntraday({securityId, exchangeSegment, instrument, interval, fromDate, toDate, oi})
//                                     → POST /charts/intraday (unwrapped payload)
//   nearMonthFuturesId(base, session) → {id, exp, seg, instrument} nearest futures >= session
//                                       (NSE preferred over BSE, from cached master CSV)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export function loadDhanEnv() {
  const file = Object.fromEntries(
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').map(l => {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/); return m ? [m[1], m[2]] : [null, null];
    }).filter(r => r[0])
  );
  return { ...file, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DHAN_') || k.startsWith('MCX_') || k.startsWith('ADVISOR_'))) };
}

function headers(env) {
  return { 'access-token': env.DHAN_ACCESS_TOKEN, 'client-id': env.DHAN_CLIENT_ID, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

export async function dhanQuote(env, segments) {
  const res = await fetch('https://api.dhan.co/v2/marketfeed/quote', {
    method: 'POST', headers: headers(env), body: JSON.stringify(segments),
  });
  const raw = await res.json();
  return 'status' in raw ? raw.data : raw; // chart/quote payloads: unwrap only when wrapped
}

export async function dhanChartsIntraday(env, { securityId, exchangeSegment, instrument, interval = 1, fromDate, toDate, oi = true }) {
  const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
    method: 'POST', headers: headers(env),
    body: JSON.stringify({ securityId: String(securityId), exchangeSegment, instrument, interval, oi, fromDate, toDate }),
  });
  const raw = await res.json();
  return 'status' in raw ? raw.data : raw;
}

// Near-month futures securityId for a base symbol (e.g. 'COLPAL') from the cached master CSV.
// Mirrors server/providers/dhan.mjs base derivation: SEM_TRADING_SYMBOL minus the month+FUT
// suffix. NSE preferred over BSE. Returns null when the master has no qualifying row.
export function nearMonthFuturesId(env, base, session) {
  const master = fs.readFileSync(path.join(ROOT, 'data', '.dhan-master.csv'), 'utf8').split('\n');
  let best = null;
  for (const row of master) {
    const c = row.split(',');
    const exch = (c[0] || '').trim();
    if (exch !== 'NSE' && exch !== 'BSE') continue;
    const seg = (c[1] || '').trim();
    const instr = (c[3] || '').trim();
    const tsym = (c[5] || '').trim().toUpperCase();
    if (seg !== 'D' || (instr !== 'FUTSTK' && instr !== 'FUTIDX') || !tsym.endsWith('-FUT')) continue;
    const hyphen = tsym.lastIndexOf('-');
    const sym = tsym.slice(0, tsym.lastIndexOf('-', hyphen - 1));
    if (sym !== base.toUpperCase()) continue;
    const exp = (c[8] || '').slice(0, 10);
    const id = (c[2] || '').trim();
    if (!exp || exp < session || !id) continue;
    const rec = { id, exp, seg: exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO', instrument: instr };
    if (!best || (best.seg === 'BSE_FNO' && rec.seg === 'NSE_FNO') || rec.exp < best.exp) best = rec;
  }
  return best;
}
