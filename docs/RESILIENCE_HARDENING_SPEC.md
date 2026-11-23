# RESILIENCE_HARDENING_SPEC — Batch-5 (architect-verified handoff)

Owner order 2026-11-23 night: backlog #2 (/api/archive guard), #3 (futures flush resilience), #4 (journal Rust hardening + rewire) — after the 13:39 IST incident where an archive request crashed with `Invalid string length` and the futures tick flush + disk write pipeline silently died for the rest of the session.

## RULE 0 — READ-FIRST MANDATE

Before ANY code: read the spec, then read EVERY file in the file map end-to-end at the named
sections. After reading, list the files you WILL touch (one line each: why + story). If a file
outside the map becomes necessary — STOP and ask. Never stage or commit another workstream's
files. Never edit `scripts/h6rs*`, `.fast/`, `server/journal.mjs` beyond what S-C explicitly
names.

## FILE MAP (read these exact files/sections first)

| File | Sections | Stories |
|---|---|---|
| `server/index.mjs` | archive request handler (search `archive failed` + `ARCHIVE_FAILED`), `checkLevelHits` (market-hours guard pattern to copy), rebuild pass telegram block (`isTradingDay` gate pattern), `queueClosedSessionArchives` | S-A |
| `server/providers/dhan.mjs` | `noteTick` (~280), minute-flush + `tickJournalTimer` (~340), `flushFuturesTickJournal`, `startTickJournal` (~330), `appendTickJournalBatch` (~157), boot `startTickJournal` call site | S-B |
| `server/journal.mjs` | whole file (S-C port must match it byte-for-byte in behaviour) | S-C |
| `server/journal.test.ts` | the edge fixtures that diverged: `starts futures evidence at the first full minute`, `can use an exact entry-boundary candle`, `never evicts unresolved cards`, plus every `trackCardFollowThrough` fixture | S-C |
| `scripts/journalPortVerify.mjs` | the parity harness (62/62 run) + the containment wrapper | S-C |
| `.fast/ports/server.journal.trackCardFollowThrough/src/lib.rs` | the current Rust port (contains the divergences) | S-C |
| `src/lib/marketSession.ts` | `isMarketSessionTime`, `isTradingDay`, `marketCloseMinuteFor` | S-A, S-B |

## STORY S-A — Archive guard (live session never archives)

Root cause (measured 2026-11-23 13:38–13:42 IST): an archive request for the live session built
a whole-day JSON that exceeded Node's max string length (`ARCHIVE_FAILED Invalid string
length`) — and the failure coincided exactly with the futures tick journal + disk write pipeline
dying (journal last write 13:39, TITAN disk last 13:41).

Changes:
1. The archive request handler REJECTS, before doing any work, when the requested date is the
   CURRENT session and the market is open or within 30 minutes of close:
   `HTTP 409 {"error":"session-live","retryAfter":"16:10 IST"}`. Any other past date proceeds
   unchanged (old behaviour preserved).
2. The rejection path must never build the payload — guard FIRST, stringify never runs.
3. Add a vitest test: live-session archive request → 409 + no payload built; past-date request
   → unchanged behaviour.

Accept: during market hours a `/api/archive/<today>` POST returns 409 instantly, past dates
archive as before, and no `ARCHIVE_FAILED` line can appear for the live session.

## STORY S-B — Futures flush resilience (isolate + self-heal)

Root cause still open: the flush pipeline (futures disk write + tick journal, both last write
~13:39–13:41) stopped when the archive failures started. Two hardening layers, plus one
diagnosis step:

1. **DIAGNOSE FIRST (before coding):** re-read `flushFuturesTickJournal` and the futures disk
   write call path. Identify how an exception outside their own try/catch could stop the 60s
   interval (unhandled rejection killing the timer callback chain, a shared
   `JSON.stringify` hitting `Invalid string length` inside the flush, or a thrown error in
   `noteTick` upstream). Write your finding in the pause summary with file:line.
2. **Isolate:** every step of the minute flush (disk futures write, tick journal append) is
   independently try/caught — one failing step must never prevent the other, and a thrown error
   must be logged once (not per tick) and swallowed.
3. **Self-heal:** add a flush-liveness watchdog — `lastFlushAt` timestamp updated on every
   successful flush; a 5-minute interval checks it: during market hours, if `now - lastFlushAt`
   > 3 minutes while feed packets are flowing, clear + recreate the flush interval and log
   `futures flush watchdog: restarted after Xs stall`.
4. **Vitest:** (a) flush survives a throwing write (journal append mocked to throw once —
   next flush succeeds); (b) watchdog recreates the interval after a simulated stall.

Accept: a forced throw inside one flush cannot stop subsequent flushes, and a stalled interval
self-recovers within 5 minutes during market hours.

## STORY S-C — Journal Rust hardening + rewire

Current state: Rust port parity 62/62 on real archive data, but journal.test.ts edge fixtures
diverge (5–7 fails when wired); wiring currently REVERTED (JS path live, containment wrapper
removed).

1. **Enumerate the divergences first:** run the JS and Rust implementations side-by-side on
   every `journal.test.ts` fixture (extend `scripts/journalPortVerify.mjs` or a new harness —
   your choice, say which). Produce a table: fixture → JS result → Rust result → first
   differing field.
2. **Fix the Rust port per divergence**, in `.fast/ports/server.journal.trackCardFollowThrough/src/lib.rs`.
   Likely suspects (verify, don't assume): `Number.isSafeInteger` vs i64 conversion, the
   `belongsToDate`/`marketParts` IST arithmetic at DST-impossible times, null vs missing field
   handling in `futuresCandles`, empty-array `minutes` semantics.
3. **Gates, in order:** (a) side-by-side harness: 100% fixture parity; (b) `journalPortVerify`
   62/62 real-archive parity; (c) full `npx vitest run` with the Rust wiring ENABLED
   (wrapper live, `FAST_ANYTHING_DISABLE` unset) — every journal test green through the Rust
   path; (d) `npx tsc --noEmit` + `npm run build`.
4. **Rewire:** restore the wrapper in `server/journal.mjs` (stringify-once cache +
   empty-minutes JS containment), env-killed by `FAST_ANYTHING_DISABLE=1`.
5. If a divergence is genuinely unfixable in Rust within this batch — say so in the pause
   summary, keep the wiring reverted, and list the exact fixture. HONEST partial completion is
   accepted; silent divergence is not.

Accept: all four gates green, wiring live, and one real-archive replay shows identical
outcomes through the Rust path.

## RESUME CHECKLIST — if the work breaks/stops midway, check IN THIS ORDER

1. `git log --oneline -8` + `git status --short` — which story-commits already landed? Which
   files are dirty (whose WIP is in the tree — never assume it's yours)?
2. Which story was last? Check for its accept-evidence (test file present? harness output
   file? log lines?) — a story without its acceptance evidence is NOT done even if committed.
3. Full suite state: `npx vitest run` — note exact failing tests; `npx tsc --noEmit`.
4. Running processes: is the dev/service instance up (`curl -s localhost:8787/api/health`),
   any stray background jobs from a previous attempt (`ps aux | grep -E 'vitest|node
   --max-old'`)? Kill only strays you started.
5. The spec's file map — re-read the sections of whatever story you resume. Never resume from
   memory of the code; re-read the current file state (another agent may have changed it).
6. Only then continue the story from its next unchecked gate. Never re-commit a story that
   already has its accept evidence.

## VERIFICATION PROTOCOL (applies to every story — beyond git)

Git presence proves nothing. Every story must show:
1. **Runtime evidence** — the actual command + output that proves the behaviour (curl, vitest
   output, harness table), with timestamps.
2. **Whole-file review** — the changed file read end-to-end after the change (not just the
   diff): imports resolve, no orphan code, no behaviour change outside the story.
3. **Relationship check** — every consumer of the changed function/field audited (grep all
   call sites) and confirmed unaffected or updated.
4. **Cross-file relation** — if the story touches a field other modules read (e.g. card.sl),
   grep every reader of that field.
5. **Full suite** — `npx vitest run` (all files), `npx tsc --noEmit`, `npm run build` — exact
   counts in the pause summary.

## Pause format

Per story: files touched · gates run (exact counts) · accept evidence · deviations from spec.
End of batch: full-suite counts + the S-C divergence table + restart needs (architect owns
restarts).
