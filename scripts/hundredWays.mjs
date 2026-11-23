#!/usr/bin/env node
/**
 * hundredWays — per-symbol DNA miner.
 *
 *   node --max-old-space-size=4096 scripts/hundredWays.mjs TITAN [horizonDays=5] [minPct=1.0]
 *
 * Loads <ROOT>/<SYM>-EQ/<SYM>-EQ1.csv into DAILY bars, computes ~100 named
 * mathematical conditions (trend/momentum/volatility/volume/position/calendar/OI),
 * and for every condition-stack reports the set of historical occurrences with
 * the WORST-CASE favourable move — the "100%-sure" number: every occurrence
 * reached at least that much within the horizon. Stacks where the worst case
 * still clears minPct across a multi-year span and a recent occurrence are the
 * owner's per-stock DNA.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { h6rsCore } from './h6rsLib.mjs';

const ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';
const FUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'data', 'fut-daily');
const args = process.argv.slice(2);
const symbol = (args[0] ?? 'TITAN').toUpperCase();
const H = Number(args[1]) || 5;
const minPct = Number(args[2]) || 1.0;
const WARMUP = 60;

function loadDaily(symbol) {
  // h6rsCore (Rust-accelerated) parses the 1m CSV and resamples to daily typed arrays;
  // we rebuild the small per-day objects the indicator layer expects.
  const core = h6rsCore(symbol, 9999, 14, ROOT);
  const n = core.closes.length;
  const bars = new Array(n);
  for (let i = 0; i < n; i++) {
    const date = core.dates[core.dayIdx[i]];
    bars[i] = { date, at: Date.parse(`${date}T09:15:00+05:30`), open: core.opens[i], high: core.highs[i], low: core.lows[i], close: core.closes[i], volume: core.vols[i] };
  }
  return bars;
}

function loadOi(symbol) {
  try {
    const f = JSON.parse(readFileSync(path.join(FUT_DIR, `${symbol}.json`), 'utf8'));
    const rows = [];
    const walk = months => {
      for (const m of months ?? []) {
        for (const r of m?.candles ?? m?.rows ?? []) {
          const date = (r.date ?? r.day ?? '').slice(0, 10);
          const oi = Number(r.oi ?? r.openInterest ?? NaN);
          if (date && Number.isFinite(oi)) rows.push({ date, oi });
        }
        if (m?.months) walk(m.months);
      }
    };
    walk(f.months ?? [f]);
    const byDate = new Map(rows.map(r => [r.date, r.oi]));
    return { byDate, dates: [...byDate.keys()].sort() };
  } catch { return { byDate: new Map(), dates: [] }; }
}

const daily = loadDaily(symbol);
const n = daily.length;
const C = daily.map(b => b.close);
const oi = loadOi(symbol);

// ── indicators ──
const sma = p => { const a = new Array(n).fill(NaN); let s = 0; for (let i = 0; i < n; i++) { s += C[i]; if (i >= p) s -= C[i - p]; if (i >= p - 1) a[i] = s / p; } return a; };
const ema = p => { const a = new Array(n).fill(NaN); const k = 2 / (p + 1); a[0] = C[0]; for (let i = 1; i < n; i++) a[i] = C[i] * k + a[i - 1] * (1 - k); return a; };
const rsi = p => { const a = new Array(n).fill(NaN); let g = 0, l = 0; for (let i = 1; i < n; i++) { const ch = C[i] - C[i - 1]; g = (g * (p - 1) + Math.max(ch, 0)) / p; l = (l * (p - 1) + Math.max(-ch, 0)) / p; a[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return a; };
const S5 = sma(5), S20 = sma(20), S50 = sma(50), E12 = ema(12), E26 = ema(26);
const rsi14 = rsi(14);
const rng = i => daily[i].high - daily[i].low;
const atr14 = new Array(n).fill(NaN);
{ let s = 0; for (let i = 0; i < n; i++) { s += rng(i); if (i >= 14) s -= rng(i - 14); if (i >= 13) atr14[i] = s / 14; } }
const volAvg20 = new Array(n).fill(NaN);
{ let s = 0; for (let i = 0; i < n; i++) { s += daily[i].volume; if (i >= 20) s -= daily[i].volume - (daily[i].volume, 0), s -= 0; if (i >= 20) { s -= daily[i - 20].volume; volAvg20[i] = s / 20; } else if (i >= 1) volAvg20[i] = s / (i + 1); } }
const hi20 = new Array(n).fill(NaN), lo20 = new Array(n).fill(NaN);
for (let i = 19; i < n; i++) { let h = -Infinity, l = Infinity; for (let j = i - 19; j <= i; j++) { h = Math.max(h, daily[j].high); l = Math.min(l, daily[j].low); } hi20[i] = h; lo20[i] = l; }
const roc = p => { const a = new Array(n).fill(NaN); for (let i = p; i < n; i++) a[i] = (C[i] / C[i - p] - 1) * 100; return a; };
const roc3 = roc(3), roc5 = roc(5), roc10 = roc(10), roc20 = roc(20);
const pctB = new Array(n).fill(NaN);
for (let i = 0; i < n; i++) { if (!Number.isFinite(S20[i])) continue; const mid = S20[i], dev = 2 * (Number.isFinite(atr14[i]) ? atr14[i] : 0) || S20[i] * 0.04; pctB[i] = (C[i] - (mid - dev)) / ((mid + dev) - (mid - dev)); }
const gapPct = new Array(n).fill(NaN);
for (let i = 1; i < n; i++) gapPct[i] = (daily[i].open / daily[i - 1].close - 1) * 100;
const oiPrev = new Array(n).fill(NaN), oiNow = new Array(n).fill(NaN);
for (let i = 0; i < n; i++) { const d = daily[i].date; const cur = oi.byDate.get(d); const prevDate = oi.dates[oi.dates.indexOf(d) - 1]; const prev = prevDate ? oi.byDate.get(prevDate) : null; if (cur != null) oiNow[i] = cur; if (prev != null && cur != null) oiPrev[i] = prev; }

// ── 100 conditions ──
const conds = [];
const add = (family, name, test) => conds.push({ family, name, test });
const upBar = i => daily[i].close > daily[i].open;
const nr7 = i => { let ok = true; for (let j = i - 6; j < i; j++) if (rng(j) < rng(i)) { ok = false; break; } return ok; };
const firstOfMonth = i => i === 0 || daily[i].date.slice(5, 7) !== daily[i - 1].date.slice(5, 7);
const lastOfMonth = i => i === n - 1 || daily[i].date.slice(5, 7) !== daily[i + 1].date.slice(5, 7);
const dow = i => new Date(daily[i].at).getUTCDay();

add('trend', 'close>SMA20', i => Number.isFinite(S20[i]) && C[i] > S20[i]);
add('trend', 'close<SMA20', i => Number.isFinite(S20[i]) && C[i] < S20[i]);
add('trend', 'close>SMA50', i => Number.isFinite(S50[i]) && C[i] > S50[i]);
add('trend', 'close<SMA50', i => Number.isFinite(S50[i]) && C[i] < S50[i]);
add('trend', 'SMA20>SMA50', i => Number.isFinite(S50[i]) && S20[i] > S50[i]);
add('trend', 'SMA20<SMA50', i => Number.isFinite(S50[i]) && S20[i] < S50[i]);
add('trend', 'stacked-up (C>S20>S50)', i => Number.isFinite(S50[i]) && C[i] > S20[i] && S20[i] > S50[i]);
add('trend', 'stacked-down (C<S20<S50)', i => Number.isFinite(S50[i]) && C[i] < S20[i] && S20[i] < S50[i]);
add('trend', 'close>SMA5', i => Number.isFinite(S5[i]) && C[i] > S5[i]);
add('trend', 'close<SMA5', i => Number.isFinite(S5[i]) && C[i] < S5[i]);
add('trend', 'SMA5>SMA20', i => Number.isFinite(S20[i]) && S5[i] > S20[i]);
add('trend', 'SMA5<SMA20', i => Number.isFinite(S20[i]) && S5[i] < S20[i]);
add('trend', '3 higher closes', i => i > 2 && C[i] > C[i - 1] && C[i - 1] > C[i - 2] && C[i - 2] > C[i - 3]);
add('trend', '3 lower closes', i => i > 2 && C[i] < C[i - 1] && C[i - 1] < C[i - 2] && C[i - 2] < C[i - 3]);
add('trend', 'close>prev high', i => i > 0 && C[i] > daily[i - 1].high);
add('trend', 'close<prev low', i => i > 0 && C[i] < daily[i - 1].low);
add('trend', 'ROC20>+3%', i => Number.isFinite(roc20[i]) && roc20[i] > 3);
add('trend', 'ROC20<-3%', i => Number.isFinite(roc20[i]) && roc20[i] < -3);
add('trend', 'ROC20>+8%', i => Number.isFinite(roc20[i]) && roc20[i] > 8);
add('trend', 'ROC20<-8%', i => Number.isFinite(roc20[i]) && roc20[i] < -8);
add('momentum', 'RSI>60', i => Number.isFinite(rsi14[i]) && rsi14[i] > 60);
add('momentum', 'RSI<40', i => Number.isFinite(rsi14[i]) && rsi14[i] < 40);
add('momentum', 'RSI>70', i => Number.isFinite(rsi14[i]) && rsi14[i] > 70);
add('momentum', 'RSI<30', i => Number.isFinite(rsi14[i]) && rsi14[i] < 30);
add('momentum', 'RSI cross-up 50', i => Number.isFinite(rsi14[i]) && Number.isFinite(rsi14[i - 1]) && rsi14[i - 1] < 50 && rsi14[i] >= 50);
add('momentum', 'RSI cross-down 50', i => Number.isFinite(rsi14[i]) && Number.isFinite(rsi14[i - 1]) && rsi14[i - 1] > 50 && rsi14[i] <= 50);
add('momentum', 'ROC5>+2%', i => Number.isFinite(roc5[i]) && roc5[i] > 2);
add('momentum', 'ROC5<-2%', i => Number.isFinite(roc5[i]) && roc5[i] < -2);
add('momentum', 'ROC5>+5%', i => Number.isFinite(roc5[i]) && roc5[i] > 5);
add('momentum', 'ROC5<-5%', i => Number.isFinite(roc5[i]) && roc5[i] < -5);
add('momentum', 'ROC3>+1.5%', i => Number.isFinite(roc3[i]) && roc3[i] > 1.5);
add('momentum', 'ROC3<-1.5%', i => Number.isFinite(roc3[i]) && roc3[i] < -1.5);
add('momentum', 'MACD hist>0', i => Number.isFinite(E26[i]) && (E12[i] - E26[i]) > 0);
add('momentum', 'MACD hist<0', i => Number.isFinite(E26[i]) && (E12[i] - E26[i]) < 0);
add('momentum', 'MACD cross-up', i => Number.isFinite(E26[i]) && Number.isFinite(E26[i - 1]) && E12[i - 1] <= E26[i - 1] && E12[i] > E26[i]);
add('momentum', 'MACD cross-down', i => Number.isFinite(E26[i]) && Number.isFinite(E26[i - 1]) && E12[i - 1] >= E26[i - 1] && E12[i] < E26[i]);
add('momentum', 'ROC10>+3%', i => Number.isFinite(roc10[i]) && roc10[i] > 3);
add('momentum', 'ROC10<-3%', i => Number.isFinite(roc10[i]) && roc10[i] < -3);
add('momentum', 'ROC10>+6%', i => Number.isFinite(roc10[i]) && roc10[i] > 6);
add('momentum', 'ROC10<-6%', i => Number.isFinite(roc10[i]) && roc10[i] < -6);
add('volatility', 'ATR expanding (>1.3x)', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] > 1.3);
add('volatility', 'ATR compressed (<0.7x)', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] < 0.7);
add('volatility', 'NR7 (narrowest of 7)', nr7);
add('volatility', 'range>2x ATR', i => Number.isFinite(atr14[i]) && rng(i) > 2 * atr14[i]);
add('volatility', 'range<0.5x ATR', i => Number.isFinite(atr14[i]) && rng(i) < 0.5 * atr14[i]);
add('volatility', '%B>0.8', i => Number.isFinite(pctB[i]) && pctB[i] > 0.8);
add('volatility', '%B<0.2', i => Number.isFinite(pctB[i]) && pctB[i] < 0.2);
add('volatility', '%B>1.0', i => Number.isFinite(pctB[i]) && pctB[i] > 1);
add('volatility', '%B<0.0', i => Number.isFinite(pctB[i]) && pctB[i] < 0);
add('volatility', 'ATR>1.5x', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] > 1.5);
add('volatility', 'ATR<0.5x', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] < 0.5);
add('volatility', 'largest range of 10', i => i > 9 && rng(i) >= Math.max(...Array.from({ length: 10 }, (_, k) => rng(i - k))));
add('volatility', 'smallest range of 10', i => i > 9 && rng(i) <= Math.min(...Array.from({ length: 10 }, (_, k) => rng(i - k))));
add('volatility', 'abs move>2%', i => Math.abs((C[i] / C[i - 1] - 1) * 100) > 2);
add('volatility', 'abs move<0.5%', i => i > 0 && Math.abs((C[i] / C[i - 1] - 1) * 100) < 0.5);
add('volatility', 'upper rejection (wick>body)', i => upBar(i) ? (daily[i].high - Math.max(daily[i].open, daily[i].close)) > Math.abs(daily[i].close - daily[i].open) : (Math.min(daily[i].open, daily[i].close) - daily[i].low) > Math.abs(daily[i].close - daily[i].open));
add('volatility', 'lower rejection (wick>body)', i => upBar(i) ? (Math.min(daily[i].open, daily[i].close) - daily[i].low) > Math.abs(daily[i].close - daily[i].open) : (daily[i].high - Math.max(daily[i].open, daily[i].close)) > Math.abs(daily[i].close - daily[i].open));
add('volatility', 'ATR>1.2x + up close', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] > 1.2 && upBar(i));
add('volatility', 'ATR>1.2x + down close', i => Number.isFinite(atr14[i]) && Number.isFinite(atr14[i - 5]) && atr14[i - 5] > 0 && atr14[i] / atr14[i - 5] > 1.2 && !upBar(i));
add('volume', 'vol>2x avg', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && daily[i].volume > 2 * volAvg20[i]);
add('volume', 'vol>3x avg', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && daily[i].volume > 3 * volAvg20[i]);
add('volume', 'vol<0.5x avg', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && daily[i].volume < 0.5 * volAvg20[i]);
add('volume', 'vol>avg + up close', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && daily[i].volume > volAvg20[i] && upBar(i));
add('volume', 'vol>avg + down close', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && daily[i].volume > volAvg20[i] && !upBar(i));
add('volume', 'highest vol of 10', i => i > 9 && daily[i].volume >= Math.max(...Array.from({ length: 10 }, (_, k) => daily[i - k].volume)));
add('volume', 'vol rising 3 bars', i => i > 2 && daily[i].volume > daily[i - 1].volume && daily[i - 1].volume > daily[i - 2].volume);
add('volume', 'vol>1.5x avg + wide range', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && Number.isFinite(atr14[i]) && daily[i].volume > 1.5 * volAvg20[i] && rng(i) > atr14[i]);
add('volume', 'vol>avg + close top25', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && rng(i) > 0 && (C[i] - daily[i].low) / rng(i) > 0.75 && daily[i].volume > volAvg20[i]);
add('volume', 'vol>avg + close bottom25', i => Number.isFinite(volAvg20[i]) && volAvg20[i] > 0 && rng(i) > 0 && (C[i] - daily[i].low) / rng(i) < 0.25 && daily[i].volume > volAvg20[i]);
add('position', 'within 2% of 20d high', i => Number.isFinite(hi20[i]) && (C[i] / hi20[i] - 1) * 100 > -2);
add('position', 'within 2% of 20d low', i => Number.isFinite(lo20[i]) && (C[i] / lo20[i] - 1) * 100 < 2);
add('position', 'new 20d closing high', i => Number.isFinite(hi20[i]) && C[i] >= hi20[i]);
add('position', 'new 20d closing low', i => Number.isFinite(lo20[i]) && C[i] <= lo20[i]);
add('position', 'within 1% of PDH', i => i > 0 && (C[i] / daily[i - 1].high - 1) * 100 > -1 && (C[i] / daily[i - 1].high - 1) * 100 < 1);
add('position', 'within 1% of PDL', i => i > 0 && (C[i] / daily[i - 1].low - 1) * 100 > -1 && (C[i] / daily[i - 1].low - 1) * 100 < 1);
add('position', 'close>PDH', i => i > 0 && C[i] > daily[i - 1].high);
add('position', 'close<PDL', i => i > 0 && C[i] < daily[i - 1].low);
add('position', 'dist 20d high < ATR', i => Number.isFinite(hi20[i]) && Number.isFinite(atr14[i]) && hi20[i] - C[i] < atr14[i]);
add('position', 'dist 20d low < ATR', i => Number.isFinite(lo20[i]) && Number.isFinite(atr14[i]) && C[i] - lo20[i] < atr14[i]);
add('calendar', 'Monday', i => dow(i) === 1);
add('calendar', 'Tuesday', i => dow(i) === 2);
add('calendar', 'Wednesday', i => dow(i) === 3);
add('calendar', 'Thursday', i => dow(i) === 4);
add('calendar', 'Friday', i => dow(i) === 5);
add('calendar', 'first trading day of month', firstOfMonth);
add('calendar', 'last trading day of month', lastOfMonth);
add('calendar', 'gap up >1%', i => Number.isFinite(gapPct[i]) && gapPct[i] > 1);
add('calendar', 'gap down <-1%', i => Number.isFinite(gapPct[i]) && gapPct[i] < -1);
add('flow', 'fut OI day chg >+3%', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && (oiNow[i] / oiPrev[i] - 1) * 100 > 3);
add('flow', 'fut OI day chg <-3%', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && (oiNow[i] / oiPrev[i] - 1) * 100 < -3);
add('flow', 'fut OI up + close up', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && oiNow[i] > oiPrev[i] && upBar(i));
add('flow', 'fut OI down + close up (short covering)', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && oiNow[i] < oiPrev[i] && upBar(i));
add('flow', 'fut OI up + close down (fresh short)', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && oiNow[i] > oiPrev[i] && !upBar(i));
add('flow', 'fut OI down + close down (long unwind)', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && oiNow[i] < oiPrev[i] && !upBar(i));
add('flow', 'regime chip = up', i => Number.isFinite(roc10[i]) && roc10[i] > 1.5);
add('flow', 'regime chip = down', i => Number.isFinite(roc10[i]) && roc10[i] < -1.5);
add('flow', 'regime chip = range', i => Number.isFinite(roc10[i]) && Math.abs(roc10[i]) <= 1.5);
add('flow', 'fut OI >+8%', i => Number.isFinite(oiNow[i]) && Number.isFinite(oiPrev[i]) && oiPrev[i] > 0 && (oiNow[i] / oiPrev[i] - 1) * 100 > 8);
console.log(`conditions: ${conds.length}`);

// ── evaluation ──
const favLong = i => { let m = -Infinity; for (let j = i + 1; j <= Math.min(i + H, n - 1); j++) m = Math.max(m, (daily[j].high / C[i] - 1) * 100); return m; };
const favShort = i => { let m = -Infinity; for (let j = i + 1; j <= Math.min(i + H, n - 1); j++) m = Math.max(m, (1 - daily[j].low / C[i]) * 100); return m; };
const evalSide = side => {
  const fav = i => side === 'LONG' ? favLong(i) : favShort(i);
  const out = [];
  for (const cond of conds) {
    const idx = [];
    for (let i = WARMUP; i + H < n; i++) if (cond.test(i)) idx.push(i);
    if (idx.length < 5) continue;
    const favs = idx.map(fav);
    const min = Math.min(...favs);
    const years = new Set(idx.map(i => daily[i].date.slice(0, 4)));
    const recentIdx = idx.filter(i => daily[i].date >= '2024-01-01');
    const recentMin = recentIdx.length ? Math.min(...recentIdx.map(fav)) : null;
    const sorted = favs.slice().sort((a, b) => a - b);
    out.push({ name: cond.name, family: cond.family, n: idx.length, min, median: sorted[Math.floor(idx.length / 2)], p90: sorted[Math.floor(idx.length * 0.9)], years: years.size, recentMin, recentN: recentIdx.length, dates: idx.map(i => daily[i].date) });
  }
  return out;
};
const longs = evalSide('LONG');
const shorts = evalSide('SHORT');
const qualified = list => list.filter(r => r.min >= minPct && r.n >= 5 && r.years >= 3 && r.recentMin != null && r.recentMin >= minPct * 0.5).sort((a, b) => b.n - a.n || b.min - a.min);

console.log(`\n=== ${symbol}: ${conds.length} conditions × LONG/SHORT × ${H}-day horizon · target ≥${minPct}% EVERY time ===`);
console.log('\n--- LONG setups: 100%-sure stacks ---');
for (const r of qualified(longs).slice(0, 15)) console.log(`  [${r.name}] n=${r.n} · worst-case move ${r.min.toFixed(2)}% · median ${r.median.toFixed(2)}% · years ${r.years} · 2024+ worst ${r.recentMin?.toFixed(2)}% (n=${r.recentN})`);
const q = qualified(shorts);
if (q.length) { console.log('\n--- SHORT setups: 100%-sure stacks ---'); for (const r of q.slice(0, 10)) console.log(`  [${r.name}] n=${r.n} · worst-case move ${r.min.toFixed(2)}% · median ${r.median.toFixed(2)}% · years ${r.years} · 2024+ worst ${r.recentMin?.toFixed(2)}% (n=${r.recentN})`); }
console.log(`\nqualified LONG ${qualified(longs).length}/${conds.length} | qualified SHORT ${qualified(shorts).length}/${conds.length}`);
const near = list => list.filter(r => r.min >= minPct * 0.8 && r.n >= 8).sort((a, b) => b.min - a.min).slice(0, 8);
console.log('\n--- near misses (worst-case 0.8-1%) ---');
for (const r of [...near(longs), ...near(shorts)].sort((a, b) => b.min - a.min).slice(0, 8)) console.log(`  [${r.name}] n=${r.n} · worst-case ${r.min.toFixed(2)}% · median ${r.median.toFixed(2)}%`);

// ── cross-family pairs (top singles by worst-case, n≥15, different families) ──
const pct2 = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const evalIdxSet = (name, family, idx, fav) => {
  if (idx.length < 4) return null;
  const favs = idx.map(fav);
  const years = new Set(idx.map(i => daily[i].date.slice(0, 4)));
  const recent = idx.filter(i => daily[i].date >= '2024-01-01');
  return { name, family, n: idx.length, min: Math.min(...favs), median: pct2(favs, 0.5), years: years.size, recentMin: recent.length ? Math.min(...recent.map(fav)) : null, recentN: recent.length };
};
const idxFor = (side, cond) => {
  const fav = i => side === 'LONG' ? favLong(i) : favShort(i);
  const idx = [];
  for (let i = WARMUP; i + H < n; i++) { let ok = true; try { ok = cond.test(i); } catch { ok = false; } if (ok) idx.push(i); }
  return { idx, fav };
};
const pairs = [];
for (const side of ['LONG', 'SHORT']) {
  const src = side === 'LONG' ? longs : shorts;
  const top = src.filter(r => r.n >= 15).sort((a, b) => b.min - a.min).slice(0, 14);
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) {
    if (top[a].family === top[b].family) continue;
    const ca = conds.find(c => c.name === top[a].name), cb = conds.find(c => c.name === top[b].name);
    const A = idxFor(side, ca), B = idxFor(side, cb);
    const setB = new Set(B.idx);
    const r = evalIdxSet(`${top[a].name} + ${top[b].name}`, 'pair', A.idx.filter(i => setB.has(i)), A.fav);
    if (r) pairs.push({ side, ...r });
  }
}
pairs.sort((a, b) => b.min - a.min || b.n - a.n);
console.log(`\n--- cross-family PAIRS: worst-case ≥ ${minPct}% (of ${pairs.length} tested) ---`);
for (const r of pairs.filter(r => r.min >= minPct).slice(0, 12))
  console.log(`  ${r.side} [${r.name}] n=${r.n} · worst +${r.min.toFixed(2)}% · median +${r.median.toFixed(2)}% · ${r.years}y · 2024+ worst ${r.recentMin == null ? '—' : '+' + r.recentMin.toFixed(2) + '%'} (n=${r.recentN})`);
const qPairs = pairs.filter(r => r.min >= minPct).length;
console.log(`pairs clearing bar: ${qPairs}`);

// ── cross-family TRIPLES (top singles, 3 distinct families) ──
const triples = [];
for (const side of ['LONG', 'SHORT']) {
  const src = side === 'LONG' ? longs : shorts;
  const top = src.filter(r => r.n >= 12).sort((a, b) => b.min - a.min).slice(0, 14);
  const tested = new Set();
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) for (let c = b + 1; c < top.length; c++) {
    const fams = new Set([top[a].family, top[b].family, top[c].family]);
    if (fams.size < 3) continue;
    const key = [a, b, c].join('|');
    if (tested.has(key)) continue;
    tested.add(key);
    const A = idxFor(side, conds.find(x => x.name === top[a].name));
    const B = idxFor(side, conds.find(x => x.name === top[b].name));
    const Cx = idxFor(side, conds.find(x => x.name === top[c].name));
    const setB = new Set(B.idx), setC = new Set(Cx.idx);
    const r = evalIdxSet(`${top[a].name} + ${top[b].name} + ${top[c].name}`, 'triple', A.idx.filter(i => setB.has(i) && setC.has(i)), A.fav);
    if (r && r.n >= 3) triples.push({ side, ...r });
  }
}
triples.sort((a, b) => b.min - a.min || b.n - a.n);
console.log(`\n--- cross-family TRIPLES: worst-case ≥ ${minPct}% (of ${triples.length} tested, n≥3) ---`);
for (const r of triples.filter(r => r.min >= minPct && r.years >= 2).slice(0, 12))
  console.log(`  ${r.side} [${r.name}] n=${r.n} · worst +${r.min.toFixed(2)}% · median +${r.median.toFixed(2)}% · ${r.years}y · 2024+ worst ${r.recentMin == null ? '—' : '+' + r.recentMin.toFixed(2) + '%'} (n=${r.recentN})`);
console.log(`triples clearing bar (n≥3, ≥2y): ${triples.filter(r => r.min >= minPct && r.n >= 3 && r.years >= 2).length}`);

writeFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'data', `hundred-ways-${symbol}.json`), JSON.stringify({ symbol, generatedAt: new Date().toISOString(), H, minPct, longs, shorts, pairs: pairs.slice(0, 100), triples: triples.slice(0, 100) }, null, 1));
console.log(`\nreport → server/data/hundred-ways-${symbol}.json`);
