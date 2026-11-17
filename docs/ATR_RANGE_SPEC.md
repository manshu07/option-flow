# ATR + plain-language range context — spec (owner-approved 2026-11-17)

**Owner's intent:** futures candles now carry real open/high/low (cfa65e0). Put them to
work in two places the owner already looks at: (1) the gamma overlay's regime line he
called confusing ("this regime make me confuse. can we do it something better?"), and
(2) the observation cards, so SL/TGT distances are judged against how far price can
realistically travel in a bar, not raw points.

**Principle (owner's words):** the game is the bar, not the timeframe. ATR answers
"एक बार में कितना चल सकता है"; every level distance becomes "inside/outside one
bar's reach" instead of a bare number.

**Files:** `src/features/market-flow/atrModel.ts` (new) + test, `src/features/strike-flow/GammaOverlay.tsx`,
its parent view (whatever passes `view.profile`), `server/strikeAdvisor.mjs`,
`server/observationCardSvg.mjs`, `server/journal.mjs`, plus their tests.
No provider changes, no new endpoints, no new timers, no December-expiry work in this
handoff (that spec is queued separately and touches journal.mjs too — land them
sequentially, never in parallel).

---

## S1 — ATR util (S)

New `src/features/market-flow/atrModel.ts`:

- `aggregateBars(candles, barMinutes = 15)` — group 1-minute candles
  (`{at, open, high, low, close}`) into `barMinutes` buckets aligned to IST session
  open (09:15), taking the first `open`, max `high`, min `low`, last `close`.
- `atrSummary(candles, { period = 14, barMinutes = 15 })` →
  `{ atr, lastBarRange, state: 'compressed' | 'normal' | 'expanded' } | null`.
  - True range per bar: `max(high − low, |high − prevClose|, |low − prevClose|)`.
  - **Fallback for old archives** (candles without high/low): `|close − prevClose|`.
  - `atr` = mean of the last `period` TRs; `null` when fewer than `period` bars exist.
  - `state`: `expanded` when `lastBarRange ≥ 1.3 × atr`, `compressed` when
    `≤ 0.7 × atr`, else `normal`.
- Unit tests: aggregation boundaries, fallback path, null path, state thresholds.

## S2 — Board regime line becomes plain language (S)

`src/features/strike-flow/GammaOverlay.tsx` (+ parent view):

- Regime chips: `Gamma Long` → **`RANGE · dips bought, breakouts fade`**;
  `Gamma Short` → **`TREND · breakouts run, don't fade`**; N/A stays `Gamma N/A`.
  Keep the colour classes; put the exact gamma terms in the chip's `title` tooltip
  (owner still wants the numbers one hover away).
- Flip label: `FLIP {level}` → `FLIP {level} · {d}×ATR` where `d = |spot − flip| / atr`;
  append `(one bar)` when `d ≤ 1`, `(far)` when `d > 2`. When `atrSummary` returns null
  (no data yet), render exactly today's labels — never a broken line.
- Parent computes `atrSummary` from the symbol's futures candles it already has
  (the same months/candles the board renders) and passes it down as one additive prop.
- Update `GammaOverlay.test.tsx` expectations; add a test for the null-ATR fallback.

## S3 — Observation card gains a Range line (M)

`server/strikeAdvisor.mjs` at card build time:

- Compute `atrSummary` for the card's symbol from the market file's futures months
  candles (the accessor already exists for spot/series — reuse the same market object).
- Additive card fields: `atr: { value, barMinutes, state }` (null when insufficient data).
- `server/observationCardSvg.mjs` `observationCaption` (owner copy) and the card SVG
  gain ONE line when `atr` is present:
  `Range: ATR(15m) {value} pts · SL {d}×ATR out · TGT1 {d}×ATR`
  with `d = |level − entry| / atr` rounded to 1 decimal. No line when atr is null.
- **`observationSubscriberCaption` stays byte-identical** — subscriber copy is frozen
  copy (owner-approved), do not touch it.
- Advisor test: symbol with synthetic 20×15-min bars produces the line; 5 bars
  produces no line and no crash.

## S4 — Journal followThrough gains post-entry spot range (M)

`server/journal.mjs` `resolveCard`/followThrough builder:

- The futures candles in the capture window now have high/low. Add to
  `outcome.followThrough`: `spot: { high, low, from, to }` — max/min of the symbol's
  futures candle highs/lows from entry minute to session close (same window rules as
  the existing sampled premium evidence, same missing-minute policy: partial windows
  report what exists, never invent).
- Rendered in the existing Post-call verification table as one extra row
  `Spot after entry: H … / L …` — no change to status/R math (that authority is frozen).
- Test: card with known candles produces exact high/low; candles missing → `spot: null`.

---

## Gates

`npm test` green, `npx tsc --noEmit` clean, `npm run build` clean.
Old archives without OHLC must render exactly as today (fallback + omission paths).
With zero new data, no UI line changes except the S2 wording swap.

## Data note

Full OHLC starts accumulating with the first session after cfa65e0. S1's fallback
exists precisely so this spec lands safely tonight and becomes fully useful as
tomorrow's session feeds real highs/lows.
