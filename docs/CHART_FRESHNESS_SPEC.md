# CHART_FRESHNESS_SPEC — session boundary hygiene + boot feed recovery (Batch-8)

Owner report 2026-11-24 ~08:00 IST (pre-open): "chart pe abhi bhi stale lines aa rahi he…
indexes + stocks + their instruments sabhi me" — measured: /api/futures serves ONLY Nov-23
candles (388/389 per symbol, zero Nov-24) because (a) feeds were stuck at 1/5 from the WS
connection-limit hangover of the backfill script, and (b) pre-open legitimately has no Nov-24
candles yet — but the board presented yesterday's session without saying so.

Two stories, ONE commit each (feat(freshness): FN1/FN2). PAUSE after each for architect
verification (owner awake).

## RULE 0 — READ-FIRST

| File | Sections | Stories |
|---|---|---|
| `server/replayStorage.mjs` | `readFutures` (~142), `persistFutures` | FN1 |
| `server/index.mjs` | `futuresFor` (~872-895, disk fast path + merge), `build()` closed-market early return (~297-331), session/`istParts` usage | FN1, FN2 |
| `src/features/market-flow/FlowDiagram.tsx` | CandleChart window + prev-close line | FN1 |
| `src/features/market-flow/marketFlowModel.ts` | `windowCandles`, session anchoring | FN1 |
| `src/features/market-flow/FlowStatus.tsx` | stale chip (`describeStale` pattern to reuse) | FN1, FN2 |
| `src/lib/marketSession.ts` | `sessionFor` (T4's new per-exchange function — reuse, do not duplicate) | FN2 |
| `server/providers/dhan.mjs` | feed reconnect paths (~794+), supervisor interplay | FN2 |

## FN1 — Session-boundary hygiene: never serve yesterday as today

1. `/api/futures/<SYM>` gains `session: <dateKey>` (the IST session date of the served
   candles) + `prevSession: <count>` (how many served candles belong to earlier sessions).
2. `futuresFor()` post-close/boot path: candles from earlier sessions are CLEARLY separated —
   the live-session series carries only TODAY's session date; the previous session's tail is
   attached as a distinct `prevDay` array (same shape), not spliced into the current series.
3. Client `CandleChart`: draws the current session's candles as the primary line; the
   previous session's tail renders dimmer/offset ONLY in auto-tf mode (to keep the ≥30-bar
   rule) and the chart prints a one-line badge `prev session tail: N candles` when used. No
   fabricated candles; every existing feature stays.
4. Status: the board's stale chip gains a `previous session shown (pre-open)` state so
   pre-open never reads as a live-but-stale board.
5. Tests: session-boundary fixture (yesterday tail + today 2 candles) → current series has
   only today, prevDay carries the tail, badge text correct; weekend fixture similar.

Accept: at 08:00 IST on a trading day the board visibly labels yesterday's data as previous
session; today's first captured candle joins ONLY the current series.

## FN2 — Boot feed recovery with connection-limit awareness

Incident 2026-11-24 ~07:45: a backfill script's dead WS sockets held Dhan's per-account
connection slots ~10–15 min; kickstarts produced 1/5 → reconnect churn until slots freed.
(The script itself is already fixed to REST-only — this story hardens the server side.)

1. `feedReinitDue`/watchdog gains: when a reconnect attempt fails with a connection-limit or
   auth-class error, back off EXPONENTIALLY (30s → 60s → 120s → capped 5 min) instead of the
   fixed 45s — hammering keeps the cap saturated.
2. Boot log line on every recovery attempt: `feed recovery attempt N (reason …)` so slot
   exhaustion is visible in the log, not guessed.
3. On full success (5/5 + flowing), one log line `feed fully recovered after Xs`.
4. No change to subscription counts or capture behaviour.

Accept: with a simulated limit-rejection, reconnect attempts back off exponentially and
recover on the next free slot; log lines present; existing watchdog tests stay green.

## GATES (per story)

Full `npx vitest run` + `npx tsc --noEmit` + `npm run build` (exact counts) → story commit
(`feat(freshness): FN1/FN2`). PAUSE after each story for architect verification. Do NOT
restart the service (architect owns restarts — pre-open restart happens ~08:55 IST by the
architect). Do NOT touch `.env`, `scripts/h6rs*`, `.fast/`, `server/journal.mjs`,
`server/mcx.mjs`.

## RESUME CHECKLIST

1. `git log --oneline -6` + `git status --short` — which FN-commits landed, whose WIP dirty?
2. Accept evidence per story present? (test file, log line, probe output)
3. `npx vitest run` exact failures + tsc.
4. Stray processes killed (only your own).
5. Re-read current file state of the story being resumed.
6. Continue from the next unchecked gate.
