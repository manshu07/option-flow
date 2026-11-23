#!/usr/bin/env node
/**
 * H6RS — Six-Phase HyperWave Reversal Sequence detector (owner PDF spec, frozen v1 rules).
 *
 *   node scripts/h6rs.mjs TITAN daily|5m
 *
 * Oscillator: RSI(14) on the bar timeframe. HWO = 2-bar-confirmed pivot turns of the oscillator.
 * State machine: Moon → Pyramid → Crown(+bull div) → Axe → M → HWO Down → HWO Up = ENTRY.
 * Frozen thresholds (not tuned): Moon origin <40, crest >=55, fall-back <40; compression = 10-bar
 * osc range <= 0.6 x Moon excursion; phase windows capped; entry measured at HWO-Up bar close.
 * Outcome: forward returns 5/10/20/30/60 bars, MFE/MAE within 30 bars, LL->HL check, volume state.
 */
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';
const [symbol = 'TITAN', tfArg = 'daily'] = process.argv.slice(2);
const TF = tfArg === '5m' ? '5m' : 'daily';

function load1m(sym) {
  const file = path.join(ROOT, `${sym}-EQ`, `${sym}-EQ1.csv`);
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let pos = 0, carry = '';
  const bars = [];
  const take = line => {
    const f = line.split(',');
    if (f.length !== 7) return;
    const [date, time, o, h, l, c, v] = f;
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return;
    const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (mins < 555 || mins > 930) return;
    bars.push({ date: date.replace(/\./g, '-'), time, o: +o, h: +h, l: +l, c: +c, v: +v || 0 });
  };
  for (;;) {
    const got = readSync(fd, buf, 0, buf.length, pos);
    if (got <= 0) break;
    pos += got;
    const lines = (carry + buf.toString('utf8', 0, got)).split('\n');
    carry = lines.pop();
    for (const l of lines) take(l);
  }
  take(carry);
  closeSync(fd);
  return bars;
}

function resample(bars, minutes) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const mins = Number(b.time.slice(0, 2)) * 60 + Number(b.time.slice(3));
    const slot = Math.floor((mins - 555) / minutes);
    const key = b.date + '#' + slot;
    if (!cur || cur.key !== key) { if (cur) out.push(cur); cur = { key, date: b.date, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  if (cur) out.push(cur);
  return out;
}

let bars = load1m(symbol);
bars = TF === 'daily' ? resample(bars, 9999) : resample(bars, 5); // 9999 = one bucket per day
const n = bars.length;
const C = bars.map(b => b.c);

// RSI(14)
const osc = new Array(n).fill(NaN);
{ let g = 0, l = 0; for (let i = 1; i < i + n; i++) { if (i >= n) break; const ch = C[i] - C[i - 1]; g = (g * 13 + Math.max(ch, 0)) / 14; l = (l * 13 + Math.max(-ch, 0)) / 14; osc[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }

const pH = i => i > 2 && i < n - 2 && osc[i] > osc[i - 1] && osc[i] > osc[i - 2] && osc[i] >= osc[i + 1] && osc[i] > osc[i + 2];
const pL = i => i > 2 && i < n - 2 && osc[i] < osc[i - 1] && osc[i] < osc[i - 2] && osc[i] <= osc[i + 1] && osc[i] < osc[i + 2];
const rngAt = (i, w) => { let mx = -1e9, mn = 1e9; for (let j = Math.max(0, i - w + 1); j <= i; j++) { mx = Math.max(mx, osc[j]); mn = Math.min(mn, osc[j]); } return mx - mn; };
const prLow = (i, w) => { let mn = 1e9; for (let j = Math.max(0, i - w + 1); j <= i; j++) mn = Math.min(mn, bars[j].l); return mn; };
const volAvg = i => { let s = 0; for (let j = Math.max(0, i - 19); j <= i; j++) s += bars[j].v; return s / Math.min(i + 1, 20); };

const MAX_PHASE = Number(process.env.H6RS_PHASE_MAX) || 40, CONF_WIN = 15, MIN_PHASE = 3;
const MIN_VOL = Number(process.env.H6RS_MIN_VOL) || 0;
const seqs = [];
let st = 0, stStart = 0, moon = null, crown = null, m1 = null;
for (let i = 15; i < n - 2; i++) {
  const age = i - stStart;
  if (st > 0 && age > MAX_PHASE) { st = 0; moon = crown = m1 = null; }

  if (st === 0) {
    // Moon: origin <40 (within last 30 bars), crest pivot >=55, then osc back below 40
    if (osc[i] < 40) {
      let sawHigh = false, peak = 0, peakIdx = -1;
      for (let j = Math.max(0, i - 30); j <= i; j++) if (osc[j] >= 55) { sawHigh = true; if (osc[j] > peak) { peak = osc[j]; peakIdx = j; } }
      let origin = 1e9;
      for (let j = Math.max(0, peakIdx - 25); j < peakIdx; j++) origin = Math.min(origin, osc[j]);
      if (sawHigh && origin < 40) {
        moon = { peak, peakIdx, origin, amp: peak - origin, pLowBefore: prLow(i, 20) };
        st = 1; stStart = i;
      }
    }
  } else if (st === 1) {
    if (i - stStart >= MIN_PHASE && rngAt(i, 10) <= 0.6 * moon.amp) { st = 2; stStart = i; }
  } else if (st === 2) {
    // Crown: two osc peaks with trough; bullish divergence vs prior trough (price LL, osc HL)
    const peaks = [];
    for (let j = Math.max(1, stStart - 1); j <= i; j++) if (pH(j)) peaks.push(j);
    if (peaks.length >= 2) {
      const p2 = peaks[peaks.length - 1], p1 = peaks[peaks.length - 2];
      let tr = p1, trOsc = osc[p1];
      for (let j = p1 + 1; j < p2; j++) if (osc[j] < trOsc) { trOsc = osc[j]; tr = j; }
      if (p2 - p1 >= 3 && tr > p1 + 1) {
        // compare with an earlier trough before p1
        let oTr1 = osc[p1], pr1 = prLow(p1, 8), found = false;
        for (let j = Math.max(1, p1 - 15); j < p1; j++) if (pL(j)) { oTr1 = osc[j]; pr1 = prLow(j, 5); found = true; break; }
        const pr2 = prLow(tr, 5);
        if (found && pr2 <= pr1 && trOsc > oTr1) { crown = { p1, p2, tr, oscTr: trOsc, prLL: pr2 }; st = 3; stStart = i; }
      }
    }
  } else if (st === 3) {
    if (i - stStart >= MIN_PHASE && rngAt(i, 10) <= 0.6 * moon.amp) { st = 4; stStart = i; }
  } else if (st === 4) {
    // M: two upper peaks with retracement between
    const peaks = [];
    for (let j = Math.max(1, stStart - 1); j <= i; j++) if (pH(j) && osc[j] >= 45) peaks.push(j);
    if (peaks.length >= 2) {
      const a = peaks[peaks.length - 2], b = peaks[peaks.length - 1];
      let tr = a, trOsc = osc[a];
      for (let j = a + 1; j < b; j++) if (osc[j] < trOsc) { trOsc = osc[j]; tr = j; }
      if (b - a >= 3 && trOsc <= osc[a] - 0.15 * moon.amp && trOsc <= osc[b] - 0.15 * moon.amp) { m1 = { a, b, tr }; st = 5; stStart = i; }
    }
  } else if (st === 5) {
    // post-M HWO Down then HWO Up within CONF_WIN
    let down = -1;
    for (let j = m1.b + 1; j <= i; j++) if (pH(j) && osc[j] > osc[j + 1]) { down = j; break; }
    if (down > 0) {
      for (let j = down + 2; j <= i; j++) {
        if (pL(j) && osc[j + 1] > osc[j]) {
          const e = j + 1;
          const fwd = k => e + k < n ? (C[e + k] / C[e] - 1) * 100 : null;
          let mfe = -1e9, mae = 1e9;
          for (let j2 = e + 1; j2 < Math.min(e + 31, n); j2++) { mfe = Math.max(mfe, (bars[j2].h / C[e] - 1) * 100); mae = Math.min(mae, (bars[j2].l / C[e] - 1) * 100); }
          const postLL = prLow(e, 15);
          seqs.push({ entryDate: bars[e].date, entryTime: TF === '5m' ? bars[e].time : undefined, entry: C[e], bars: e - (moon.peakIdx - 25), fwd5: fwd(5), fwd10: fwd(10), fwd20: fwd(20), fwd30: fwd(30), fwd60: fwd(60), mfe, mae, hlFormed: bars[Math.min(e + 5, n - 1)].l > postLL, volState: (bars[e].v / volAvg(e)).toFixed(2), lengthBars: e - moon.peakIdx });
          st = 0; moon = crown = m1 = null;
          break;
        }
      }
    }
  }
}

const pct = (a, p) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const stats = list => list.length ? { n: list.length, fwd5: pct(list.map(s => s.fwd5), .5), fwd10: pct(list.map(s => s.fwd10), .5), fwd20: pct(list.map(s => s.fwd20), .5), mfeMed: pct(list.map(s => s.mfe), .5), mfeWorst: pct(list.map(s => s.mfe), 0), maeWorst: pct(list.map(s => s.mae), 0), hl: list.filter(s => s.hlFormed).length } : null;
console.log(`\n=== H6RS ${symbol} ${TF}: ${n} bars · RSI(14) · frozen v1 rules${MIN_VOL ? ` · vol gate ≥${MIN_VOL}x` : ''} ===`);
console.log(`entries detected: ${seqs.length}${MIN_VOL ? ` · after vol gate: ${seqs.filter(s => +s.volState >= MIN_VOL).length}` : ''}`);
if (seqs.length) {
  for (const s of seqs.slice(-20)) console.log(`  ${s.entryDate}${s.entryTime ? ' ' + s.entryTime : ''} entry=${s.entry.toFixed(1)} · fwd5 ${s.fwd5?.toFixed(2)}% fwd10 ${s.fwd10?.toFixed(2)}% fwd20 ${s.fwd20?.toFixed(2)}% · MFE30 ${s.mfe.toFixed(2)}% MAE30 ${s.mae.toFixed(2)}% · HL ${s.hlFormed ? 'yes' : 'no'} · vol ${s.volState}x · len ${s.lengthBars}b`);
  for (const k of ['fwd5', 'fwd10', 'fwd20', 'fwd30']) console.log(`  ${k}: median ${pct(seqs.map(s => s[k]), .5).toFixed(2)}% · p25 ${pct(seqs.map(s => s[k]), .25).toFixed(2)}% · min ${pct(seqs.map(s => s[k]), 0).toFixed(2)}%`);
  console.log(`  MFE30: median ${pct(seqs.map(s => s.mfe), .5).toFixed(2)}% · p25 ${pct(seqs.map(s => s.mfe), .25).toFixed(2)}% · worst ${pct(seqs.map(s => s.mfe), 0).toFixed(2)}%`);
  console.log(`  MAE30: median ${pct(seqs.map(s => s.mae), .5).toFixed(2)}% · worst ${pct(seqs.map(s => s.mae), 0).toFixed(2)}%`);
  console.log(`  HL formed within 5 bars: ${seqs.filter(s => s.hlFormed).length}/${seqs.length} · vol>1x at entry: ${seqs.filter(s => +s.volState > 1).length}/${seqs.length}`);
  const gated = stats(seqs.filter(s => +s.volState >= 1.2));
  if (gated) console.log(`  [vol≥1.2x subset] n=${gated.n} · fwd5 ${gated.fwd5.toFixed(2)}% fwd10 ${gated.fwd10.toFixed(2)}% fwd20 ${gated.fwd20.toFixed(2)}% · MFE med ${gated.mfeMed.toFixed(2)}% worst ${gated.mfeWorst.toFixed(2)}% · MAE worst ${gated.maeWorst.toFixed(2)}% · HL ${gated.hl}/${gated.n}`);
}
writeFileSync(path.resolve(HERE, '..', 'server', 'data', `h6rs-${symbol}-${TF}.json`), JSON.stringify({ symbol, tf: TF, rules: 'frozen-v1: RSI14 40/55, pivots, comp 0.6xMoon', entries: seqs }, null, 1));
console.log(`\nreport → server/data/h6rs-${symbol}-${TF}.json`);
