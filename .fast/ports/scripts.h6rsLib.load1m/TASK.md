# Port `scripts.h6rsLib.load1m` to Rust

You're in a Rust crate (napi-rs) fast-anything generated for this: `/Users/himanshuvaghela/emdash-projects/order-flow/.fast/ports/scripts.h6rsLib.load1m`.
Write `load1m` in `src/lib.rs` so it behaves **exactly** like the JavaScript below, and runs fast.
Only edit files in this folder. Don't touch the JavaScript project.

## The original (scripts/h6rsLib.mjs:7)

```js
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
```

## Real calls

fast-anything recorded 1 real calls (out of 1 while the app ran). A few:

```
load1m("TITAN")  ->  [{ date: "2015-02-02", time: "09:16", o: 428.85, h: 429.5, …
```

## Rules

- Same result for every input, edge cases included: empty input, zero, negatives, NaN and infinity, non-ASCII text, very long input. verify tests these too.
- JavaScript strings are UTF-16: `.length`, indexing and `charCodeAt` count UTF-16 code units. Use `s.encode_utf16()` for anything index- or length-based (bytes are fine after checking `is_ascii()`).
- JavaScript numbers are f64. Integer math is exact only up to 2^53; use `f64` unless the values are clearly small integers.
- Results are compared with a relative tolerance of 1e-9. Keep the same order of float operations.
- Where JavaScript throws, return `Err(Error::from_reason(...))`.
- Each call crosses from JavaScript into Rust: keep conversions cheap, don't clone big inputs.
- Make it fast: no needless allocation, borrow, `with_capacity`, fast paths for common cases.
- Keep `#[napi(js_name = "load1m", catch_unwind)]` as it is.
- Note: no TypeScript types, types are inferred from recorded calls.

## Check

Run `cargo check` here. Then fast-anything builds the crate in release mode and replays all 1 recorded calls against it
(`fast-anything verify scripts.h6rsLib.load1m`).
