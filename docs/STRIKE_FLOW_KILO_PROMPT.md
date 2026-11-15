# KILO PROMPT — Strike Momentum Flow (Options Board) ST2+ST3

**Repo:** `~/emdash-projects/order-flow` · branch `main` · pull first (`git pull origin main`).
**You own:** new `src/features/strike-flow/*` + one small `src/App.tsx` edit. Nothing else.
**Server is DONE and pushed (`ab1b51f`) — do not touch `server/`.** If you think the server
needs a change, STOP and report it; that lane belongs to the architect.

---

## 0) Working setup — READ FIRST

- **NEVER restart the main dev server** (ports 8787/5195, already running). Work on a second
  tree — this is a proven pattern:
  `PORT=8790 VITE_PORT=5196 npm run dev` → your app at **http://127.0.0.1:5196**.
- **You do NOT need live market or a fresh token.** Develop against Friday's captured
  archive: the endpoint works for `date=2026-11-13` right now. If you find yourself blocked
  or "waiting for Monday" — STOP: that is a wrong assumption, the data is already there.
  (This exact wrong assumption burned you last time — do not repeat it.)
- Before writing code, confirm your working tree is the repo above: `git status` must show
  your changes when asked to hand over. Work not written to disk = work that does not exist.
- Constraints: **Vitest only** (no Playwright/E2E), **no new dependencies**, **live Order
  Flow page behavior must not change at all** (old must work — this is a hard rule).
- When you add ANY genuinely new helper/component, your delivery notes must state: why it is
  required, what happens if it is added, and where the impact lands. If an existing export
  can be reused by merely adding `export` to it, do that instead of copying code — and list
  every such export in your delivery notes. Never copy-paste market-flow internals.

## 1) Read these files BEFORE designing anything (touchpoints, in order)

1. `docs/STRIKE_FLOW_SPEC.md` — the contract you are implementing (ST2, ST3).
2. `src/features/market-flow/MarketFlowPage.tsx` — page shell pattern (header, window
   selector, how the flow + board + status compose).
3. `src/features/market-flow/FlowDiagram.tsx` — the diagram: tiles, DiagramCard, CandleChart,
   how the S-curve layout is assembled. Your Strike Flow page looks like this, with option
   contracts instead of underlyings.
4. `src/features/market-flow/diagramModel.ts` — REUSE `sCurve`, `compressedScale`,
   `compressedTicks`, `candlesFromCloses` (session-anchored resampling), `drawnValues`.
5. `src/features/market-flow/FlowParts.tsx` — REUSE `BuildMark`, `buildUpText`, `ChangeText`,
   `DotMeter`, `Ring` pattern, `Spark`, `toneOf`, `pctText`, `signedText`, `heatStyle`.
6. `src/features/market-flow/FlowStatus.tsx` — status-line wording pattern.
7. `src/features/market-flow/marketFlowModel.ts` — `heaviestLevels` (OI walls → S/R),
   `clockOf`, `levelText`, `compactUnits`; `FlowCandle` shape.
8. `src/features/options-scanner/futuresModel.ts` — `readFuturesWindow` (the lookback +
   tolerance pattern you must mirror for strike windows) and `futuresBuildUp`.
9. `src/lib/buildUp.ts` — `classify` + floors per timeframe (5m/15m/1h/1d). Reuse, do not
   invent new build-up labels or thresholds.
10. `src/features/market-flow/feed.ts` — fetch/abort/parse patterns (`fetchFutures`,
    `fetchReplayFutures`).
11. `server/index.mjs` route `^/api/strikes/([^/]+)$` + `strikeFlowFromFiles` — the exact
    payload you will consume (read the code, don't guess the shape).

If a shared market-flow component needs an `export` keyword added to be reused: add ONLY
`export`, change no behavior, and list it in delivery notes. Copying >30 lines of market-flow
code instead of exporting it = reject.

## 2) ENDPOINT (already working — verify with this curl before coding)

```
curl "http://127.0.0.1:8790/api/strikes/NIFTY?date=2026-11-13"
```
Returns `{ symbol, date, expiry, minuteCount, spot: [[t, spot]], strikes: { "25150|CE":
{ strike, side, expiry, prevClose, prevOi, ltp, oi, volume, spotDistancePct,
series: [[t, ltp, oi, volume]] } } }`. `asOf=HHMM` truncates everything (no lookahead) and
recomputes the last readings. 64 strikes max, within 5% of last spot, nearest ATM.
Errors: 400 invalid symbol/asOf · 404 no stored minutes · 503 archive read failure —
show an honest message, never a fake state.

## 3) DESIGN — pixel-level (match the reference; do not freestyle)

Layout, top to bottom (this mirrors the Order Flow page's visual language — same fonts,
radii, hairlines, colors from `market-flow.css` / `flowChartModel` tone classes):

1. **Tab bar (App.tsx):** two tabs — `Order Flow` (default, unchanged) | `Strike Flow`.
   Same capsule/tab styling as the app's existing chrome. No more tabs, no dropdowns.
2. **Header row:** left = symbol chips `[NIFTY] [BANKNIFTY] [SENSEX]` + `[F&O Stocks ▾]`
   (stock picker select; chips are single-select, active chip filled like ReplayControls'
   selected day chip). Right = side pills `All · CE · PE` (single-select, "Momentum Flow"
   is the page title next to it — bold, small caps like the reference).
3. **Status line** (FlowStatus wording): `6 up · 0 flat · 48 down of 54 · As of 13 Nov, 15:40
   · spot to 15:40` — counts from your readings; "As of" = now (live) or the replay/as-of
   time; up/flat/down by premium change sign (flat = |change| below the timeframe's noise
   floor from `buildUp.ts`).
4. **Distribution strip:** dot histogram of premium change %, symmetric range scaled to the
   day's data (reference shows ±75.2% — compute yours from the readings, clamp the axis
   label at a round number). Green right of 0, red left. Reuse the Order Flow strip's build.
5. **Flow diagram (the core):**
   - Two halves: bullish (premium change > 0) on top, bearish below, split at the 0% line —
     same halves/geometry approach as `FlowDiagram` (`flowLayout.ts` rows + `gateRows`).
   - **Units = option contracts**: label format `NIFTY 25150C` / `NIFTY 24550PE` (strike in
     hundreds compacted exactly like the reference: 25150 → "2515" row tag with full strike
     on cards; tiles may truncate with `…` but keep tooltip full).
   - Tile content: strike label, premium change % (signed, tone-colored), build-up pill
     (`buildUpText`; "Spot only" replaced by "No OI" for contracts with oi always null),
     mini Spark line of the contract's premium series.
   - Y-axis: reuse `compressedScale` + `compressedTicks`; ticks like +20/+10/+5/+2/+1/0.5/
     −0.5/−1/−2/−5/−10/−20 (the scale input is premium % — pick reach from the data).
   - Time axis: 09:15 → 15:40 with the dashed vertical close marker (date-aware close via
     `marketSessionBounds` — 15:40, not 15:30 — but tick labels may show 15:30/15:40 per
     the captured data's actual span) and ticks ~09:15/11:00/12:00/13:00/14:00/15:30.
   - **Spot reference line:** the endpoint's `spot` series drawn dashed across the diagram,
     labelled in a bottom-left legend chip `NIFTY +x.xx%` (tone-colored) — exactly the
     reference's "NIFTY −17.97%" chip.
   - Left gradient rails (green top half, red bottom half) with the % labels between.
6. **Large cards (top movers per side, 2–4 cards per side max):**
   - Row 1: strike label `NIFTY 25150C` + build-up badge (BULLISH/BEARISH pill) + conviction
     ring (reuse Ring; checks = the build-up's sign conditions measured: premium window move,
     OI window move, volume pace, distance-from-spot sanity, spot-direction agreement —
     exactly 5 checks, held/counted; if you cannot measure one honestly, it counts as not
     counted, never as failed).
   - Row 2: big premium change % (tone-colored) + `₹<ltp> <±change>` under it.
   - Row 3: mini premium candle/line chart from the contract's series — candles via
     `candlesFromCloses(series→closes, span)` with the TF picker (Auto/1m/5m/15m/30m) —
     plus dashed S1/R1 level lines with right-edge tags.
   - Row 4: `SUPPORT <strike> · ZONE <premiumLow>–<premiumHigh> · RESISTANCE <strike>`:
     SUPPORT = the heaviest PE-OI strike below spot from the endpoint's strikes map; ZONE =
     the contract's own premium range over the selected window; RESISTANCE = the heaviest
     CE-OI strike above spot. Same strike may appear as both a card and a wall — that is
     correct (it means the contract sits ON the wall).
   - Range bar (spot between S/R) — reuse `RangeBar`'s pattern.
7. **Popup (pin/click):** taller version of the card chart + the reading in words
   (reuse FlowPopup's composition and `buildUpText` sentences adapted to contracts).
8. **Empty/honest states:** no stored minutes for the picked symbol/date → "No captured
   chain for <SYM> on <date> yet" (404); archive read failure → retry button (503);
   contracts with <3 series points → "Too few minutes yet for a line".

## 4) STORY ORDER + STOP POINTS (checkpoints)

- **ST2a:** `strike-flow/feed.ts` + `strikeFlowModel.ts` + tests → STOP (verify: `npm test`,
  `npm run lint`). The architect reviews the math before any UI.
- **ST2b:** `StrikeFlowPage.tsx` + `App.tsx` tab → STOP (verify: tests + lint + build;
  manual: your tree at :5196 shows ranked NIFTY contracts from `date=2026-11-13`).
- **ST3:** cards + popup + S/R walls + TF picker on card charts → STOP (full gates).
- At every STOP: leave the tree building, list changed files, list every market-flow export
  you added, list every NEW thing with the why/impact/where note. The architect verifies,
  commits (split by story), and pushes. Do not commit or push yourself.
- Replay integration (asOf from the replay cursor) is a stretch goal — only after ST3 is
  verified; the endpoint already supports it.

## 5) TESTS (Vitest, fixed dates, no fake market)

- `strikeFlowModel.test.ts`: window math — Day vs prevClose (and prevClose null → % null),
  intraday lookback honoring window minutes + tolerance (a 7-minute gap is not "5m"),
  OI change sign/percent (prevOi null → % null, change may still be absolute? — NO: without
  prevOi the OI change vs "nothing" is not printed either; null stays null),
  `classify()` mapping per timeframe floor, ranking order, NEUTRAL floor, All/CE/PE filter.
- Page test: renders the ranked list for a small fixture payload; side filter works;
  honest empty state on 404 payload. No network in tests — feed functions take fixtures.
- `npm test && npm run lint && npm run build` must pass at every STOP.

## 6) HARD GUARDRAILS (known failure modes — from history)

1. Do NOT invent numbers. A missing baseline = no percentage. Zero OI = no build-up label.
2. Do NOT redesign the visual language. Same tones/hairlines/typography as the existing
   board. The reference screenshot defines LAYOUT, the repo defines STYLE.
3. Do NOT touch: `server/`, `src/features/market-flow/*` internals (exports only),
   `src/lib/marketSession.ts`, `public/underlyings.json`, `.env`, other docs.
4. Do NOT report done without the gates passing, and do NOT claim blockers without checking
   the repo first (the data for `date=2026-11-13` exists NOW).
5. Do NOT add dependencies, state libraries, or chart libraries — SVG by hand like the rest
   of the app.
6. Do NOT work in silence past a STOP point — the checkpoint ritual is verify → commit by
   owner → push, done by the architect at your pause.
