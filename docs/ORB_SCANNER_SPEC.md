# ORB scanner — opening-range breakout automation (owner's playbook, spec)

**Owner:** the 9:15–9:30 playbook, stated 2026-11-17. **Status:** spec only —
nothing implemented. **Kept deliberately separate** from the December-expiry
work (owner: "for ORB create something separated, don't combine everything").

**The playbook it automates:**
1. 09:15–09:20 — first 5-minute candle per stock = the opening range.
2. 09:20 — OI change ≥ 5–7% must confirm participation; soft here, firm at entry.
3. 09:20 — the stock's sector must agree with where NIFTY is trending.
4. 09:30 — breakout of the first-candle high (or PDH) = the watch trigger;
   SL reference = the 09:20 candle low.
5. A stock that opened +4–5% is NOT chased — it waits for a VWAP touch.

All inputs are already captured: per-minute futures OHLC (`cfa65e0`), chain OI
vs prevOi, session volumes. PDH/PDL needs one new read (see S1).

---

## S1 — Range data (server/orbModel.mjs + tests)

- `openingRange(candles)` — aggregate the 09:15–09:20 1-minute futures candles
  (reuse `aggregateBars` from `src/features/market-flow/atrModel.ts` with
  barMinutes = 5) → `{ high, low, width }`; null before 09:20.
- `sessionVwap(candles)` — Σ(typical × volume) / Σvolume over session minutes
  (typical = (H+L+C)/3); null when volumes are missing.
- `prevDayLevels(held)` — PDH/PDL from the provider's daily-candle fetch
  (`restFuturesMonth` already reads Dhan daily OHLC arrays); cached per
  symbol+session so it is one REST read per day, paced by the existing chain
  limiter.

## S2 — Scanner state (server/orb.mjs + tests)

Per symbol, re-evaluated each market-file build (no new timers — the build
loop already runs):
- `state: 'building' (before 09:20) → 'armed' → 'broken-out' (first-candle
  high crossed) → 'extended-wait' (opening move ≥ 4%) → 'entered-zone'
  (VWAP touched after extended-wait) / 'done'`.
- `extended` when `open→09:20 close ≥ +4%` (owner's 4–5% rule, use 4).
- OI gate: chain OI change ≥ 5% at evaluation time (soft at 09:20, required
  from 09:30). Sector gate: ON only when the sector map exists (S4) — never
  blocks on its own before that.
- Output per symbol: `{ symbol, state, rangeHigh, rangeLow, vwap, pdh, pdl,
  oiPct, wapTouchAt }` — pure function of the market file + caches, fully
  unit-testable (synthetic candle fixtures).

## S3 — Surfacing (server/index.mjs + Telegram)

- `GET /api/orb` — the current list (board can render it later; no UI in this
  spec).
- Telegram: ONE message at **09:35 IST** and one at **10:05 IST** to the same
  audience as the EOD (owner + subscribers, footer + disclaimer):
  `🚀 ORB 09:35 · breakouts: ITC 295↑ (OI +11%) · extended-wait: IEX (−1% open)
  · SL refs: first-candle low`. Plain English only; no entry/SL prescriptions —
  levels are data. Suppress when nothing qualifies ("no qualified breakouts
  today" once, not twice).
- Day-keyed dedupe: the two messages are the day's entire ORB push.

## S4 — Parked: sector mapping

`public/underlyings.json` has no sector field today. When a mapping lands
(one static JSON, NSE sector per symbol), the sector gate flips on in S2 and
the message gains `sector ✓/✗`. Nothing else changes.

## Gates

`npm test`, `npx tsc --noEmit`, `npm run build` clean. ORB adds no
subscriptions, no provider changes, no new timers (evaluation rides the
existing build loop). December-expiry files untouched.
