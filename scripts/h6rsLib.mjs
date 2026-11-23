// h6rsLib — shared loader/resampler extracted so fast-anything can profile + port it.
import { openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

export const CSV_ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';

export function load1m(sym, root = CSV_ROOT) {
  const file = path.join(root, `${sym}-EQ`, `${sym}-EQ1.csv`);
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

export function resample(bars, minutes) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const mins = Number(b.time.slice(0, 2)) * 60 + Number(b.time.slice(3));
    const slot = Math.floor((mins - 555) / minutes);
    const key = b.date + '#' + slot;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, date: b.date, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// loadBars — one big call: CSV parse + resample into typed arrays (no per-bar JS objects).
// Returns { dates, dayIdx, mins, closes, highs, lows } for the RSI/state-machine layer.
export function loadBars(sym, minutes, root = CSV_ROOT) {
  const bars = load1m(sym, root);
  const dates = [];
  const dateIdx = new Map();
  const outCloses = [], outHighs = [], outLows = [], outVols = [], outOpens = [], outDay = [], outMins = [];
  let curSlot = -1, curDay = -1, h = 0, l = 0, c = 0, v = 0, o = 0, w = 0;
  for (let i = 0; i < bars.length; i++) {
    const m = Number(bars[i].time.slice(0, 2)) * 60 + Number(bars[i].time.slice(3));
    let d = dateIdx.get(bars[i].date);
    if (d == null) { d = dates.length; dates.push(bars[i].date); dateIdx.set(bars[i].date, d); }
    const s = Math.floor((m - 555) / minutes);
    if (s !== curSlot || d !== curDay) {
      if (w > 0) { outCloses.push(c); outHighs.push(h); outLows.push(l); outVols.push(v); outOpens.push(o); outDay.push(curDay); outMins.push(curSlot * minutes + 555); }
      curSlot = s; curDay = d; h = -Infinity; l = Infinity; c = 0; v = 0; o = 0; w = 0;
    }
    if (w === 0) o = bars[i].o;
    h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l); c = bars[i].c; v += bars[i].v; w++;
  }
  if (w > 0) { outCloses.push(c); outHighs.push(h); outLows.push(l); outVols.push(v); outOpens.push(o); outDay.push(curDay); outMins.push(curSlot * minutes + 555); }
  return {
    dates,
    dayIdx: Int32Array.from(outDay),
    mins: Int32Array.from(outMins),
    closes: Float64Array.from(outCloses),
    highs: Float64Array.from(outHighs),
    lows: Float64Array.from(outLows),
    vols: Float64Array.from(outVols),
    opens: Float64Array.from(outOpens),
  };
}

// h6rsCore — parse → resample → RSI. The RSI loop stays byte-identical to scripts/h6rs.mjs.
export function h6rsCore(sym, minutes, rsiP, root = CSV_ROOT) {
  const { dates, dayIdx, mins, closes, highs, lows, vols, opens } = loadBars(sym, minutes, root);
  const n = closes.length;
  const osc = new Float64Array(n);
  const p = rsiP;
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(ch, 0)) / p;
    l = (l * (p - 1) + Math.max(-ch, 0)) / p;
    osc[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return { dates, dayIdx, mins, closes, highs, lows, vols, opens, osc };
}

// >>> fast-anything: scripts.h6rsLib.h6rsCore >>>
// Uses the verified Rust port. FAST_ANYTHING_DISABLE=1 runs the JavaScript above instead.
// Undo with:  fast-anything disable scripts.h6rsLib.h6rsCore
if (!process.env.FAST_ANYTHING_DISABLE) {
  try {
    h6rsCore = process.getBuiltinModule("node:module").createRequire(import.meta.url)("../.fast/lib/fa_scripts_h6rslib_h6rscore.node").h6rsCore;
  } catch {}
}
// <<< fast-anything: scripts.h6rsLib.h6rsCore <<<
