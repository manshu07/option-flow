# REPLAY V2 SPEC — Reliable capture + any-day replay

> Owner: Kilo Code (implementation) · Verifier: Qwen (PM/architect — verification only, no implementation)
> Estimated: **28 SP** across 9 stories. **No Playwright/E2E dependency anywhere** — every story is
> verified with Vitest unit/integration tests, scripted HTTP smoke checks, and a short manual
> checklist. Playwright stays parked (G2/G5 deferred; do not spend time on it).

## Context

Replay V1 (commit `247d93d`) replays the current/most-recent session from live-captured minute
snapshots (`server/data/<provider>/<date>/<HHMM>.json` + `index.json`) and futures persisted per
symbol (`server/data/<provider>/<date>/futures/<SYMBOL>.json`). V1 gaps G1–G6 are registered in
`docs/DHAN_PROVIDER_HANDOFF.md` §7. V2 makes capture **self-driving** (no page required) and
sessions **archived and replayable forever**.

## Hard constraints (every story)

1. **No Playwright/E2E.** No new Playwright code, no browser dependency, no E2E acceptance gates.
2. **No Dhan calls in tests.** Tests use fixture providers (`MF_PROVIDER=recorded` with tmp dirs)
   or inject data directly. Never read `.env`.
3. **No lookahead.** A futures candle may appear in an as-of read only when
   `candle.at + 60_000 <= cursorMs` (its interval has completed). Same rule for any new as-of read.
4. **Live behavior preserved.** When replay is inactive, `/api/market`, `/api/futures`,
   `/api/status` responses and the live board must be unchanged. Capture must never block or slow
   a live request (fire-and-forget, own errors swallowed + logged).
5. **File boundaries.** Kilo may touch: `server/index.mjs`, new `server/archive.mjs`, new
   `server/capture.mjs`, `src/features/market-flow/{replayModel.ts, useReplayFlow.ts,
   ReplayControls.tsx, feed.ts, market-flow.css}`, their test files, `package.json` (no new heavy
   deps — use `node:zlib`). Kilo must NOT touch: `server/providers/dhan.mjs`,
   `server/providers/index.mjs`, `src/lib/marketSession.ts` (read-only import ok),
   `public/underlyings.json`, `.env`, `docs/DHAN_PROVIDER_HANDOFF.md`.
6. **Upstream hygiene.** Never edit `public/underlyings.json`; keep changes additive; no
   refactors of upstream code.
7. Per story: run `npm test` + `npm run lint` + `npm run build`; list what you changed and how
   each acceptance criterion is met. The verifier re-runs everything.

## Sprint A — V1.1 quick fixes (8 SP)

### S1 — Post-close chain stability (2 SP) — `server/providers/dhan.mjs`
**Problem.** After close, chains with sparse live state fall to REST and 429 → builds show
196–211/215 instead of 215/0.
**Change.** In `optionChain`: when the feed has been stale >60 s AND the prev-day seed has
completed for that symbol (`seeded.has`) AND a cached chain exists in `lastChain` — serve the
cached chain unconditionally (drop the `legs >= 1` requirement for this branch). Fresh feed
(healthy within 60 s) keeps today's exact behavior.
**Acceptance.**
- Unit test: with a stale `feedHealthyAt`, a symbol having a cached chain (even sparse) is served
  from cache, `restChain` never called.
- Unit test: with a healthy feed and ≥3 legs, live chain is served as today.
- Unit test: cached chain older than 6 h is not served (falls through).
**Verify (PM).** After close: `curl /api/status` → series 215, failed 0, build <2 s, repeatedly.

### S2 — Replay timeline unification 15:30 → date-aware close (2 SP) — `replayModel.ts`
**Problem.** `boardReplayMinutes` clips at `sessionEndOf(date)` (fixed 15:30) while capture
reaches the date-aware derivatives close (15:40 for current dates) — 10 captured minutes are
unreachable.
**Change.** `boardReplayMinutes` uses `marketSessionBounds(Date.parse(date+'T12:00:00+05:30')).close`
(import from `@/lib/marketSession`) instead of `sessionEndOf(date)`.
**Acceptance.**
- Unit test (explicit dates, no real clock): minutes at 15:35 for a current date (≥2026-08-03)
  are INCLUDED; minutes for 2026-07-01 are clipped at 15:30.
- Unit test: minutes outside 09:15..close still excluded.
**Verify (PM).** Next live session: manifest `end` ≈ 15:39–15:40 and the replay slider reaches it.

### S3 — Playback speed control (3 SP) — `useReplayFlow.ts`, `ReplayControls.tsx`
**Problem.** Playback is fixed at 700 ms per minute (~86×).
**Change.** Add a speed selector (0.5× / 1× / 2× / 5×; default 1×) rendered as small pill buttons
in `ReplayControls`; interval = `700 / speed`. Persist choice in `localStorage` alongside the
universe preference pattern. Keep play/pause-at-end/return-to-live semantics unchanged.
**Acceptance.**
- Unit test: interval derivation for each speed (expose a pure `playbackIntervalMs(speed)`).
- Component test: clicking a speed changes the interval (assert via fake timers).
- Manual: 2× visibly twice as fast as 1×.
**Verify (PM).** Open replay, switch speeds, confirm pacing changes.

### S4 — Configurable server ports for side-by-side runs (1 SP) — `server/index.mjs`, `start.mjs`-style runners
**Problem.** Replay/tooling servers hardcode 8787/5195, so they cannot run next to the live board.
**Change.** `PORT` already exists; make the Vite dev port configurable via env
(`VITE_PORT`, default 5195) in `scripts/dev.mjs`'s web spawn, and let `checkProvider`/tooling
accept `PORT`. No defaults change.
**Acceptance.** `VITE_PORT=5196 npm run dev` serves the page on 5196 with live data.
**Verify (PM).** Run the command above while the main board stays on 5195.

## Sprint B — V2 capture & archive (20 SP)

### S5 — Server-side session capture (5 SP) — new `server/capture.mjs` + wiring in `server/index.mjs`
**Problem.** Futures persistence is page-driven (G6): no page open during market hours = replay
has prices only.
**Change.** A capture loop (default every 60 s, env `MF_CAPTURE_SEC`) that, while
`isMarketSessionTime(Date.now())` and the provider is not `alwaysLive`, calls the existing
`futuresFor(symbol, session)` for every mapped symbol — a few per tick (≤3 concurrent, honoring
the provider's own throttles), rotating through the universe. Failures are logged and simply
retried next rotation. `POST /api/capture/now` (optionally protected later) triggers an immediate
full pass. Capture state exposed on `/api/status` as `capture: { done, total, lastPassAt }`
(additive field only).
**Acceptance.**
- Integration test: with a fixture provider and a fake session window, one capture pass writes
  `futures/<SYMBOL>.json` files for every fixture symbol under a tmp `MF_DATA_DIR`.
- Integration test: a symbol whose provider read fails is logged, retried next pass, and does not
  break the pass.
- Integration test: no capture passes run when `isMarketSessionTime` is false.
- `/api/status` still serves its original fields (additive `capture` only).
**Verify (PM).** During market hours (or with the recorded fixture replaying), watch
`server/data/.../futures/` fill to 215 files within one rotation without the page open.

### S6 — EOD archive (5 SP) — new `server/archive.mjs` + wiring
**Problem.** Minute snapshots are pruned daily (today-only retention) — sessions vanish.
**Change.** After the session's last capture pass (or on `POST /api/archive/<date>`), write
`archives/<date>.json.gz` = gzip of `{ date, minutesIndex, minutes: {hhmm: snapshot}, futures:
{symbol: persistedFile} }` using `node:zlib`. Keep `N` most recent archives (env
`MF_ARCHIVE_KEEP`, default 30). Also expose `GET /api/archive` (list with sizes + coverage) and
`GET /api/archive/<date>` (metadata only).
**Acceptance.**
- Unit tests: round-trip gzip → identical JSON; retention keeps newest N and deletes the rest;
  malformed archive returns a clean error.
- Integration test: archive a fixture day, list it, read a minute back out of the archive.
**Verify (PM).** Trigger manually, confirm the `.gz` round-trips and the list endpoint is right.

### S7 — Archive read API (3 SP) — `server/archive.mjs` + routes in `server/index.mjs`
**Problem/Change.** Reading must work straight from the archive: `GET /api/archive/<date>/minute/<HHMM>`
and `GET /api/archive/<date>/futures/<SYMBOL>?asOf=HHMM` (same truncation rule as S5 of V1:
`at + 60_000 <= asOf`). Missing minute/symbol → explicit 404 `{error, code:'ARCHIVE_MISSING'}`.
Never touches the provider. Day-cache headers like the existing minute route.
**Acceptance.**
- Contract tests: known minute returns the stored snapshot byte-for-byte (JSON-equal); missing
  minute returns 404 with `ARCHIVE_MISSING`; as-of futures truncation correct at a boundary minute.
**Verify (PM).** Curl a known minute + an as-of futures read from the archived fixture day.

### S8 — Multi-day replay (5 SP) — `useReplayFlow.ts`, `replayModel.ts`, `feed.ts`
**Problem/Change.** `useReplayFlow` accepts a `{ requested, date }` date that can be ANY archived
day: on request it prefers archive reads (`/api/archive/...`) and falls back to live-capture
reads (`/api/replay/...`) when the date is today. All existing semantics preserved: no lookahead,
gaps as gaps, pause at end, return-to-live. `boardReplayMinutes` (S2) applies per date.
**Acceptance.**
- Integration tests (jsdom + msw-style fetch stubs or injected fetch): archived day loads,
  seeking works, as-of futures are truncation-correct, missing minutes pause playback with the
  captured-range message.
- Unit test: archive-vs-capture source selection for today vs past dates.
**Verify (PM).** Archive today, restart the server (captures wiped), replay today purely from the
archive; then replay a second archived day.

### S9 — Replay session picker (2 SP) — `ReplayControls.tsx`, `feed.ts`
**Problem/Change.** A compact day list (from `GET /api/archive` + today's capture) lets the user
pick which session to replay; shows per-day capture coverage (minutes count, futures symbols,
gaps). Keyboard accessible; live board untouched when closed.
**Acceptance.**
- Component test: list renders dates + coverage; picking a date calls the handler with it.
**Verify (PM).** Two archived days appear; switching between them replays each correctly.

## Out of scope (parked): multi-day OI analytics, speed beyond 5×, order placement,
re-baselining `docs/DHAN_PROVIDER_HANDOFF.md` §7 (G1/G4 entries close via S1/S2; the rest stay).

## Story order (dependency-driven)
S5 (capture — foundation) → S6 (archive) → S7 (archive reads) → S8 (multi-day) → S9 (picker);
Sprint A items are independent and can interleave anytime.
