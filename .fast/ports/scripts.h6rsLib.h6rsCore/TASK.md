# Port `scripts.h6rsLib.h6rsCore` to Rust

You're in a Rust crate (napi-rs) fast-anything generated for this: `/Users/himanshuvaghela/emdash-projects/order-flow/.fast/ports/scripts.h6rsLib.h6rsCore`.
Write `h6rsCore` in `src/lib.rs` so it behaves **exactly** like the JavaScript below, and runs fast.
Only edit files in this folder. Don't touch the JavaScript project.

## The original (scripts/h6rsLib.mjs:90)

```js
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
```

## Helpers it calls

Port these as private Rust functions in the same crate (they stay in JavaScript for everyone else).

```js
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
```

## Real calls

fast-anything recorded 1 real calls (out of 1 while the app ran). A few:

```
h6rsCore("TITAN", 5, 14)  ->  { dates: ["2015-02-02", "2015-02-03", "2015-02-04", "2015-0…
```

## Rules

- Same result for every input, edge cases included: empty input, zero, negatives, NaN and infinity, non-ASCII text, very long input. verify tests these too.
- JavaScript strings are UTF-16: `.length`, indexing and `charCodeAt` count UTF-16 code units. Use `s.encode_utf16()` for anything index- or length-based (bytes are fine after checking `is_ascii()`).
- JavaScript numbers are f64. Integer math is exact only up to 2^53; use `f64` unless the values are clearly small integers.
- Results are compared with a relative tolerance of 1e-9. Keep the same order of float operations.
- Where JavaScript throws, return `Err(Error::from_reason(...))`.
- Each call crosses from JavaScript into Rust: keep conversions cheap, don't clone big inputs.
- Make it fast: no needless allocation, borrow, `with_capacity`, fast paths for common cases.
- Keep `#[napi(js_name = "h6rsCore", catch_unwind)]` as it is.
- Note: calls loadBars, they get ported together with it.
- Note: no TypeScript types, types are inferred from recorded calls.

## Check

Run `cargo check` here. Then fast-anything builds the crate in release mode and replays all 1 recorded calls against it
(`fast-anything verify scripts.h6rsLib.h6rsCore`).
