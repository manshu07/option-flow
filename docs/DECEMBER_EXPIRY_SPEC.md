# Next-month (December) expiry capture + advisor policy — Spec

**Owner:** Kilo Code · Architect/verifier: Qwen · Date: 2026-11-17
**Owner's ask:** "lets add december then I will keep eye on journal as well" —
capture the NEXT expiry alongside the nearest one so observation cards can be
built on the slower-decaying month when the nearest expiry is too close.

**Size:** ~10 SP across 4 stories. One commit per story (A→D). Pause after
each story's tests pass; the architect verifies at the end.

---

## Why (one paragraph)

Today every symbol carries exactly one captured chain — the nearest live
expiry (`buildWindows` picks `held.expiries.find(e => e >= today)`). Cards on a
6-DTE weekly bleed ~5–8% of premium per day, which is why the owner wants the
month for holds. The December chain is not subscribed at all, so no card can
exist on it. This spec adds a second, narrower subscription window for the
next expiry, carries it in the same market file as a `next` block, and lets the
advisor choose the expiry; the journal learns to read the card's own expiry.

---

## Capacity math (load-bearing, do not skip)

- Dhan: max **5 connections**, max **5,000 instruments per connection**.
  Today: 4 conns → conn0 645 core, conns 1–3 carry 13,295 option legs
  (≈4,432 each).
- December at ±7 strikes: 215 symbols × 15 strikes × 2 legs ≈ **6,450 legs**.
  5 conns → 645 core + 4 × 5,000 = **20,645 slot budget**; 13,295 + 6,450 =
  **19,745** ✓ fits with ~900 slack.
- ±8 strikes would be 7,310 → 20,605 total, only 40 slots of slack — too
  tight. **Use ±7 (`STRIKES_EACH_SIDE`-style window 15 strikes).**
- Guard: before opening connections, count `coreKeys + optionKeys`; if >
  24,500 trim the December window to ±5 then ±3 and log the trim. Never exceed
  the cap; a rejected subscribe loses instruments silently otherwise.

---

## Story A — provider: fifth connection + December window (dhan.mjs)

1. `NEXT_EXPIRY_STRIKES_EACH_SIDE = Number(process.env.DHAN_NEXT_STRIKES) || 7`;
   feature switch `DHAN_NEXT_EXPIRY` (default ON; `0` disables everything in
   this spec and behaviour is byte-identical to today).
2. `buildWindows(session)` grows a second pass per symbol:
   - `near = held.expiries.find(e => e >= today)` (unchanged);
   - `next = held.expiries.find(e => e > near)` — the following live expiry;
     skip when absent.
   - `held.nextWindow = { expiry: next, window: nearestStrikes(next strikes,
     spot, NEXT_EXPIRY_STRIKES_EACH_SIDE), center: spot }`.
   - Push its legs onto `optionKeys` exactly like the near window (same
     `legSeg` rule).
   - Return `{ coreKeys, optionKeys, nextOptionCount }` for logging.
3. Open **5** connections instead of 4: conn0 = core, conns 1–4 share
   `optionKeys` (`i % (conns.length - 1)`). Existing watchdog/backoff applies
   unchanged.
4. `optionChain(u, expiry)` for the `next` expiry reads its own window from
   `held.nextWindow` (same feed-reading path; no new REST).
5. `rebalance()` keeps the next window in sync the same way it keeps the near
   one (centre drift, strikes joining/leaving).
6. Log line at boot: `dhan: feed want N (core C, near O, next X)`.
7. Tests (vitest, fixtures, no network): window picks the SECOND expiry; cap
   guard trims when over; `DHAN_NEXT_EXPIRY=0` yields today's exact shape.

## Story B — market file `next` block (marketFile.mjs, index.mjs, client parser)

1. `encodeSeries(underlying, chain, readAt, nextChain = null)` appends an
   optional block to the series:
   ```js
   next: { e, t, sp, pc, atm, r }   // same 18-field row shape, own expiry
   ```
   Built by the same `legRow` helper; omitted when `nextChain` is null/empty.
2. `build()` in `server/index.mjs`: for each underlying, after the near chain,
   ask the provider for the next expiry (`provider.optionChain(u, live[1])`)
   when `live[1]` exists and the provider is configured for it; pass the
   encoded chain into `encodeSeries`. A next-chain failure must NOT fail the
   symbol — log once per build and continue with near only.
3. Client `parseMarketFile` (options-scanner model) and the strike-flow
   parser must tolerate the extra key (no schema change: `next` is additive).
   If a type guard rejects unknown keys, extend it — nothing else in the chart
   pipeline may change (the board keeps rendering the NEAR chain).
4. Tests: series with `next` round-trips; series without `next` byte-identical
   to today; build tolerates a failing next chain.

## Story C — advisor expiry policy + journal expiry-aware lookup

1. **Advisor** (`server/strikeAdvisor.mjs`): chain selection at card build:
   - `chooseChain(series, now)`: if `series.next` exists AND the near expiry's
     DTE ≤ `ADVISOR_NEXT_EXPIRY_DTE` (env, default 3) → build the card on the
     `next` block; otherwise the near chain (today's behaviour).
   - `candidateStrikes`, `chainWalls`, gamma profile, entry/SL/TGT all read the
     chosen block (near uses `r`/`atm`/`sp`, next uses `next.r`/`next.atm`/
     `next.sp`); `card.expiry` = chosen expiry. No other card fields change.
   - Rationale comment in code: the near weekly bleeds ~5–8%/day inside 3 DTE;
     the monthly decays ~1–1.5%/day.
2. **Journal** (`server/journal.mjs`) `rowFor(card, snapshot)`: the card's own
   `expiry` selects the chain — if `card.expiry === series.e` use `series.r`;
   if `card.expiry === series.next?.e` use `series.next.r`; otherwise no row.
   Resolution rules stay exactly as today (same-minute = ambiguous, open at
   close, missing minute = skip). Archived snapshots carry `next` because they
   store the whole market file — nothing else to change.
3. Tests: advisor picks next expiry at 3 DTE and near at 8 DTE; card carries
   the chosen expiry; journal resolves a card whose expiry lives in `next`;
   resolves nothing when neither chain matches.

## Story D — observability + rollout

1. `/api/status` (and the boot log) reports next-expiry coverage: how many
   symbols carried a `next` block in the last build.
2. `.env` knobs documented in the commit message: `DHAN_NEXT_EXPIRY` (on/off),
   `DHAN_NEXT_STRIKES` (default 7), `ADVISOR_NEXT_EXPIRY_DTE` (default 3).
3. First-day caveat to log once: December rows have no `prevOi` until a full
   session with the new capture has passed (the `/optionchain` seed is dead),
   so December OI-change reads are `null` on day one; gamma (premium-derived)
   and absolute-OI walls work immediately.

---

## Hard boundaries

- Do not change the Option Board's rendering or the strike-flow payload: the
  board keeps showing the nearest chain.
- Do not touch triage (`typesafe.mjs`) logic, alert thresholds, the digest
  cadence, or the subscriber caption.
- No new REST endpoints or timers. If the 5-connection subscribe is rejected,
  log loudly and fall back to 4 connections WITHOUT December (never silently
  drop the near chain).
- Every new user-visible number keeps the existing disclaimer wording.

## Gates

`npm test` green (314 baseline + new), `npx tsc --noEmit` AND `npm run build`
clean (`tsc -b` is stricter — run both), `git diff --check` clean. One commit
per story: `feat(expiry): A provider`, `feat(expiry): B market file`,
`feat(expiry): C advisor+journal`, `feat(expiry): D observability`.

## Verification the architect will run

1. Restart; `/api/status` shows a `next` block on most symbols and the boot log
   `core C, near O, next X` fits under 24,500.
2. A NIFTY/BANKNIFTY card built with near DTE ≤ 3 lands on the December expiry
   and its entry/SL/TGT match the `next` rows.
3. Journal: card outcome resolves from the card's own expiry (near or next).
4. Capture size/backpressure: one minute-file write stays < ~2.5 MB and the
   archive/day stays sane.