# BATCH7_SPEC — MCX session model (T4) + journal observability (T5) + observations render perf (T6)

Handed 2026-11-24. Three independent stories, ONE commit each, PAUSE after each story for
architect verification (owner is awake today — per-story checkpoints apply, NOT full-batch).

## RULE 0 — READ-FIRST MANDATE

Read the spec, then every file/section below END-TO-END before writing a line. After reading,
state one line per file you WILL touch (why + story). A file outside the map → STOP and ask.
Never touch `.fast/`, `scripts/h6rs*`, `docs/MCX_*` (architect-owned).

| File | Sections | Stories |
|---|---|---|
| `src/lib/marketSession.ts` | whole file — `marketParts`, `isMarketSessionTime`, `isTradingDay`, `marketCloseMinuteFor`, holiday list | T4 |
| `server/mcx.mjs` | whole file (328 lines) — `mcxSessionOpen` is the logic that MIGRATES to the shared session model | T4 |
| `server/index.mjs` | `mcx` integration block (~1489-1516), history-refresh chain (`startHistoryRefreshChain`), archive handler (`ARCHIVE_FAILED` path), rebuild pass | T4, T5 |
| `server/journal.test.ts` | whole file — every `trackCardFollowThrough` fixture | T5 |
| `scripts/journalPortVerify.mjs` | parity harness | T5 |
| `.fast/ports/server.journal.trackCardFollowThrough/src/lib.rs` | current Rust port | T5 |
| `src/features/observations/ObservationsPage.tsx` | `Card` component, render flow (flat + club), `achievedZone` Map, `zoneFor` | T6 |
| `server/providers/dhan.mjs` | `noteTick` (~280-390), minute flush (~340), `appendTickJournalBatch` (~157-165) | T5 |
| `server/data/logs/order-flow.launchd.out.log` | 2026-11-23T08:08–08:12Z lines (`archive failed: ARCHIVE_FAILED Invalid string length`) — the incident window | T5 |

## T4 — Per-exchange session model (MCX Phase 1)

Goal: one source of truth for session windows per exchange, so the MCX module stops carrying
its own copy and future consumers can ask "is MCX open right now?".

1. `marketSession.ts` gains:
   - `MCX_OPEN_MINUTE = 9*60+0`, MCX close rule: **Nov 1 → Mar 31 = 23:30, Apr 1 → Oct 31 =
     23:55** (approximate official rule; `MCX_CLOSE_MINUTE` env still overrides when set).
   - `MCX_HOLIDAYS`: a const array of the 2026 remaining MCX holidays you can confirm from a
     public source — if unverifiable, ship an EMPTY array + a `// TODO: confirm MCX 2027 list`
     comment (conservative: MCX-open/NSE-closed days will just have no NSE data; acceptable).
   - `isTradingDay(at, exchange = 'NSE')` and `isMarketSessionTime(at, exchange = 'NSE')` —
     default parameter keeps EVERY existing call site byte-identical (old must keep working).
   - `sessionFor(exchange)` returning `{ openMinute, closeMinute, dateKey }` for NSE and MCX.
2. `server/mcx.mjs`: `mcxSessionOpen` now delegates to `isMarketSessionTime(now, 'MCX')` —
   delete the local duplicate window logic (spec-approved deletion: the local copy is replaced,
   not kept). Behaviour must stay identical (09:00–23:30 default today).
3. **Scope guard:** nothing else switches to MCX in this story. The NSE advisor/capture/cards
   path is untouched.
4. Vitest: (a) NSE behaviour unchanged on existing tests; (b) MCX: open at 09:00, inside at
   12:00 and 22:00, closed at 23:31, winter vs summer close via the date rule, holiday skip;
   (c) `server/mcx.mjs` tests still green after the migration.

Accept: old call sites untouched (grep audit of `isMarketSessionTime(` consumers listed in the
pause summary), MCX window correct at all four boundary dates, full suite green.

## T5 — Journal observability: prove the 13:39 flush death (or rule it out)

Known: 2026-11-23 08:08–08:12Z the log showed repeated `archive failed: ARCHIVE_FAILED Invalid
string length`, and the futures tick journal (last write 13:39 IST) + TITAN disk futures (last
13:41) stopped at the same time. Batch-5 S-B added isolation + a watchdog, but the MECHANISM
that stopped the flush was never proven.

1. **Instrument:** `server/providers/dhan.mjs` flush path gains counters updated on every
   flush: `{ flushCount, lastFlushAt, lastError, lastErrorAt }` exposed on the provider's
   `health()` (and therefore `/api/health`). Additive only.
2. **Report:** `scripts/futuresFlushReport.mjs <date>` — reads `<date>/futures/*.json` +
   `futures-ticks.ndjson` + the launchd out log, and prints: per-symbol first/last write, gaps
   >5 min, and the archive-failure log lines in the same window. Output = the evidence table
   for the incident, reproducible any day.
3. **Run it for 2026-11-23** and record the output in `docs/journal-flush-incident-2026-11-23.md`
   with your conclusion: does the evidence show the flush died WITH the archive failures, or
   independently? One paragraph, evidence-cited, no speculation without a line number.
4. No behaviour change to flush semantics beyond Batch-5 S-B (already shipped). If the report
   reveals an actual bug (e.g. a path where the archive failure can still reach the flush), fix
   it as part of this story and add the regression test.

Accept: counters live on `/api/health`, report script runs for any past date, incident doc
written with cited evidence.

## T6 — Observations render perf (client)

Measured: server answers in 30ms; the lag is client render — every 30s poll re-renders every
visible Card (each carries an SVG mini-chart + option rows), and nothing is memoized.

1. `Card` becomes `React.memo` with a custom comparator: re-render ONLY when this card's
   `optionTicks` ltp/oi changed, its own `outcome` changed, or `spots[symbol]` changed. A global
   refetch with unchanged values must NOT re-render a card.
2. Verify the sticky `achievedZone` Map still works (it lives outside the component — memo does
   not affect it; assert with the existing tests).
3. Club + flat + table views all keep working; pagination stays applied before render.
4. Vitest: (a) existing observations tests stay green; (b) one render-count test: parent
   re-render with identical props renders each memoized Card exactly once.

Accept: 30s poll with unchanged data produces zero Card re-renders (measured via the
render-count test); a changed ltp re-renders only the touched card.

## RESUME CHECKLIST (if work stops midway — in this order)

1. `git log --oneline -8` + `git status --short` — which story-commits landed, whose WIP is dirty?
2. Which story's accept evidence exists (test file, report file, log lines)? Committed without
   evidence = NOT done.
3. `npx vitest run` exact failures + `npx tsc --noEmit`.
4. Stray processes from previous attempts — kill only ones you started.
5. Re-read the current file state of the story you resume (another agent may have changed it).
6. Continue from the next unchecked gate. Never re-commit a story with existing evidence.

## VERIFICATION PROTOCOL (every story)

1. Runtime evidence: command + output + timestamp proving the behaviour.
2. Whole-file re-read after the change (imports, orphans, no out-of-story behaviour).
3. Call-site/consumer audit via grep for every changed function/field — listed in the pause.
4. Full suite + `npx tsc --noEmit` + `npm run build`, exact counts.
5. Pause format: files touched · gates · accept evidence · deviations.

## Out of scope

- MCX option chains, cards, advisor, journal for MCX (Phase 2+).
- Any change to `server/journal.mjs` JS logic (S-C owns only the Rust port + its tests).
- Time-spaced chart x-axis (owner rejected).
- Restarting the service (architect owns the single post-close restart).
