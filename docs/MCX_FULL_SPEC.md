# MCX_FULL_SPEC — MCX end-to-end integration with live dashboard (Batch-MCX, Kilo)

Owner order 2026-11-24: "complete the MCX complete end to end 100% with live dashboard" —
full integration, not a light version. Scope: GOLD, SILVER, NATURALGAS + GOLDM, SILVERM,
NATURALGASM futures (option chains LAST story). Owner is awake today (NSE holiday) — but work
in FULL-BATCH MODE: all stories in ONE run, per-story commits, single pause at the very end.
The architect verifies everything once, then ONE service restart.

## RULE 0 — READ-FIRST MANDATE

Read this spec + every file/section below end-to-end BEFORE coding. After reading, list the
files you WILL touch (one line each: why + story). A file outside the map → STOP and ask.

| File | Sections | Stories |
|---|---|---|
| `server/providers/dhan.mjs` | SEG_BYTE map, feed subscribe path (buildWindows/rebalance), `noteTick` (~280), minute flush, `backfillTodayFutures` (~947), `parseTodayIntraday` | C0, C1 |
| `docs/mcx-spike-contracts.json` | the 6 securityIds + options rows (4320 GOLD option rows = strike universe) | C0, C6 |
| `src/lib/marketSession.ts` | `sessionFor('MCX')`, `isTradingDay(at,'MCX')`, `isMarketSessionTime(at,'MCX')` (T4, committed f07f5de) | C1+ |
| `server/mcx.mjs` | existing quote-poll (M1/M2) — MIGRATES to feed ticks in C2, brief/alerts stay | C2, C3 |
| `public/underlyings.json` | universe schema (symbol/exchange/lot/expiry fields — study NSE entries' shape) | C1 |
| `server/index.mjs` | build() series assembly, market file shape, `sendOwnerAndSubscribers` | C1, C2, C3 |
| `src/features/market-flow/` | exchange capsule (NSE/BSE pattern c8945f1), FlowDiagram/CandleChart, marketFlowModel | C2 |
| `server/journal.mjs` | `resolveCard`, `trackCardFollowThrough` (works on any capture snapshots) | C4 |
| `server/strikeAdvisor.mjs` | earlyCards momentum trigger pattern (OI+price), INDEX_SYMBOLS precedent | C4 |
| `scripts/ingestMoveStats.mjs` | stats schema (percentiles per entry time/hold) — MCX variant | C3 |
| `server/moveStats.mjs` / FUT stats store | where MCX FUT stats must live (labelled `instrument: 'MCX-FUT'`) | C3 |

## HARD CONSTRAINTS (from the 2026-11-24 connection-limit incident)

1. **MCX rides the EXISTING provider's WS connections — NEVER a second provider.init().**
   6 futures instruments join the existing subscription plan (tiny vs 4687 cap).
2. **No service restart by the implementer.** Architect owns the single restart.
3. Old NSE/BSE behaviour must stay byte-identical — MCX is purely additive (new exchange tag
   `MCX`, new segment `MCX_COMM`, 6 symbols, filtered into its own view, never merged into
   NSE/BSE lists — owner rule c8945f1: exchanges are separate views, never merged).

## C0 — LIVE TICK SPIKE (gates everything)

Tonight during MCX evening session (17:00–23:30 IST): build `scripts/mcx-tick-spike.mjs` that
opens ONE temporary WS to Dhan (its own connection is fine tonight — the live server has 0
packets to steal on a holiday), subscribes the 6 futures securityIds on `MCX_COMM`, captures
10 minutes of ticks, and writes `/tmp/mcx-ticks.json`.
Report per symbol: tick count, LTP changes, **OI field present? values changing?**, volume.
If OI ticks are ABSENT: STOP after C0, report — C1+ scoping changes (zones/build-up read OI;
without OI ticks, cards degrade to price-only and the owner decides).

## C1 — Universe + capture + history

1. `underlyings.json`: 6 MCX entries `{symbol, exchange:'MCX', segment:'MCX_COMM',
   securityId(fut), lot, tick, expiry-calendar-note}` — study NSE entry shape, extend the
   schema minimally, keep every NSE/BSE entry untouched.
2. Feed: the 6 MCX futures join the existing subscription plan (conn assignment per the
   provider's own builder — under its cap).
3. Capture: MCX symbols flow into the SAME per-minute market file (series entries tagged with
   exchange 'MCX') and per-symbol futures files `futures/<MCXSYM>.json` with OHLC+OI —
   names don't collide with NSE stocks (verified).
4. Boot/backfill: `backfillTodayFutures` and the charts/intraday path gain MCX securityIds
   (exchangeSegment `MCX_COMM`, instrument per master row) so restarts backfill MCX too.
5. Tests: capture writes MCX series; NSE/BSE files unchanged; backfill merge field-level.

## C2 — Live dashboard: MCX tab + flow cards

1. Exchange capsule becomes `NSE | BSE | MCX` (same PageBar chrome, remembered
   `orderFlow:exchange:v1` — extend the type; MCX view hides the Nifty/All-F&O universe
   switch, shows only the 6 symbols).
2. MCX view renders the 6 futures as flow cards using the EXISTING pipeline: LTP live from
   ticks, OI + build/unwind zone via the existing `readZone` on the futures series (works on
   futures OI without an option chain), prev-close line, mini chart with tfs.
3. Status/stale chips reuse `describeStale` with the MCX session window (09:00–23:30/23:55 via
   `sessionFor('MCX')`).
4. Tests: MCX tab renders 6 cards; zone from a synthetic OI-shedding futures series reads
   `unwind`; NSE/BSE views unchanged.

## C3 — History + realistic levels

1. Backfill daily candles for the 6 MCX futures via charts historical (as far back as Dhan
   serves — report the range) into the FUT stats store labelled `instrument: 'MCX-FUT'`.
2. `adaptiveLevels` for MCX cards uses MCX-FUT percentiles (p30/p70 favourable, p85 adverse —
   same reach-rate semantics, direction pitfall respected).
3. Tests: MCX fixture card gets history-based levels with the label; missing-stats fallback
   = fixed-sane band (existing guard).

## C4 — Movement cards + journal + alerts (the trader value)

1. Advisor MCX path: OI + price momentum trigger on futures ticks (build-up = OI rising with
   price, unwind = OI falling with price — same semantics as stock zones), early-style cards
   into the observations store with `exchange: 'MCX'`, entry = futures LTP, levels from C3.
2. Journal: `resolveCard`/`trackCardFollowThrough` resolve MCX cards against MCX capture
   minutes — same first-touch semantics.
3. Level-hit alerts + evening brief (existing mcx.mjs M1/M2) now source from LIVE ticks and
   the session guard uses `isMarketSessionTime(now, 'MCX')` (already wired in Batch-7 T4).
4. Telegram copies: no OI text for subscribers (standing rule).
5. Tests: MCX card lifecycle (build → journal resolve → level alert once-per-day), subscriber
   copy has no OI.

## C5 — Dashboard extras (owner-visible completeness)

- MCX cards on the observations page (exchange filter gains MCX; club-by-symbol works —
  6 symbols group naturally).
- Level-alert history visible.
- Nothing NSE/BSE changes visually.

## C6 — Option chains for GOLD/SILVER (LAST, gated on feed-load measurement)

Only after C1–C5 are live AND you measure the added subscription load: GOLD+SILVER option
chains ±10 strikes around spot on their own conn or added per cap-guard. Then PCR + option-
strike cards for MCX mirror the stock flow. If the cap-guard trims aggressively, report and
stop — owner decides next.

## EDGE CASES — pre-answered

| Case | Behaviour |
|---|---|
| Token expires (~06:00) | post-close for both markets — safe; owner rotates in the morning |
| NSE holiday, MCX open (like today) | MCX flows independently; NSE view static — by design |
| MCX-only holiday | `MCX_HOLIDAYS` array — empty this batch (conservative: MCX module just gets no ticks, logs) |
| Midnight | MCX closes 23:30/23:55 — before midnight, date key stable |
| OI ticks absent (C0 finding) | STOP after C0, report |
| Capture dir | same `<date>/<HHMM>.json` market files; MCX series tagged exchange 'MCX' |
| SecurityId master lookup | reuse Kilo's spike parse (SEM_TRADING_SYMBOL base derivation) |

## LIMITATIONS (state in final summary)

- MCX holidays not confirmed (empty list — conservative direction).
- Option chains only GOLD/SILVER in C6 (NATURALGAS options thin — report strike count first).
- MCX move stats depend on Dhan's historical depth for MCX futures (report the range).

## GATES (per story)

Full `npx vitest run` + `npx tsc --noEmit` + `npm run build` (exact counts) → per-story commit
(`feat(mcx): CN`). No service restarts (architect owns them). One PAUSE at the very end with:
files touched per story, gates, accept evidence, deviations, restart needs.

## RESUME CHECKLIST (if the run stops midway)

1. `git log --oneline -10` + `git status --short` — which C-commits landed, whose WIP dirty?
2. Accept evidence per landed story present? Committed without evidence = NOT done.
3. Full suite exact failures + tsc.
4. Stray probe processes — kill only your own.
5. Re-read this spec + current file state of the story being resumed.
6. Continue from the next unchecked gate. Never re-commit a story with existing evidence.
