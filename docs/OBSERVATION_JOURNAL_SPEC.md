# Jev Decision Journal — Spec (Phase 1)

**Owner:** Kilo Code (implementer) · Architect/verifier: Qwen · Date: 2026-11-16
**Size:** ~8 SP · **Branch:** `main` (single commit: `feat(journal)`)

## Why

The advisor writes observation cards with calibrated judgments (quality, watch,
bias, strike pick) and premium-derived levels (entry/SL/TGT1/TGT2). Nobody
measures whether those judgments were right. The captured per-minute snapshots
(1.29 MB each, every session minute) are the ground truth, so outcomes can be
computed deterministically. **Code grades; Jev never grades itself** — no model
call anywhere in this feature.

## Rule reminders (from the development rulebook)

- Additive only. Do not touch `server/strikeAdvisor.mjs` decision logic, the
  alert fire path, `server/typesafe.mjs`, or any client code in this phase.
- Reuse the existing minute readers; do not invent a new store.
- Old must work: if minute files are missing for a card's window, the card
  stays `open` — never guessed.

## Data you will read

- Minute snapshots: `<SCAN_DIR>/<date>/<HHMM>.json` (HHMM IST, 0915–1540),
  schema `{ t, date, series: [{ s, sp, pc, r: [[strike, side, ltp, prevClose,
  oi, prevOi, volume, …], …] }] }`. Read them with the same helpers the server
  already uses (`readMinutes` in `server/index.mjs` line ~85 reads the index;
  per-minute JSON via fs — keep the read pattern identical to
  `lastStoredMinuteFile`).
- For closed/archived days: `readArchiveMinuteFallback(SCAN_DIR, service,
  date, minute)` in `server/archive.mjs` line ~801 (already used by
  `/api/archive/...`).
- Cards live in `<DATA_DIR>/observations.json`: `{ cards: [card] }`, card has
  `id, at (epoch ms), date, symbol, bias, side ('CE'|'PE'), strike, expiry,
  entry, sl, tgt1, tgt2, quality, …`.

## New file: `server/journal.mjs`

Export pure functions (all unit-testable without fs or network) plus one
runner:

```js
/** Walk one card forward through minute snapshots.
 *  minutes: ascending array of parsed snapshot objects (see Data above).
 *  Returns the outcome record, or null while nothing is settled. */
export function resolveCard(card, minutes) {}

/** Resolve every card once per session date; writes outcomes back. */
export async function runJournal({ obsPath, readMinute, now, log, send }) {}
```

### `resolveCard(card, minutes)` — the decision table (pure)

For each snapshot at or after `card.at` (same `date`):

1. Find the card's option row: `series.s === card.symbol`, row `r[0] ===
   card.strike && r[1] === (card.side === 'CE' ? 0 : 1)`. Premium = `r[2]`.
   Missing row → skip that minute (contract absent from the strike window is
   normal after big moves — do not invent).
2. Track, in order of minutes:
   - first premium `<= card.sl` → SL hit (premium-based levels only in v1)
   - first premium `>= card.tgt1` → TGT1 hit
   - first premium `>= card.tgt2` → TGT2 hit
   - running MFE = max(premium − entry) (bullish) / (entry − premium)
     (bearish)… actually simpler and symmetric: `mfe = max(premium) − entry`
     for bullish, `entry − min(premium)` for bearish; `mae` the other side.
   - Also record spot touch order at the same minutes if both premium events
     land in the SAME snapshot: status `ambiguous` (conservative — count as SL
     for stats, flagged).
3. Stop at the first settled state:
   - SL first → `{ status: 'sl', r: -1 }`
   - TGT1 first → `{ status: 'tgt1', r: (tgt1 − entry) / (entry − sl) }`
   - TGT2 first (without TGT1? impossible — TGT1 < TGT2 always) → same as tgt1
     plus `tgt2: true`
   - Session end (last snapshot ≤ 15:40) with no hit → `{ status: 'open' }`
     with `mfe`/`mae` — still useful, marked unresolved.
4. Outcome record shape, written onto the card:
   ```js
   card.outcome = {
     status: 'sl' | 'tgt1' | 'ambiguous' | 'open',
     r: number | null,          // R multiple, null when open
     mfe: number, mae: number,  // premium points
     tgt2: boolean,
     hitAt: number | null,      // epoch ms of the settling snapshot
     minutes: number | null,    // snapshots after card.at
     computedAt: number,
   }
   ```
   Never mutate any other card field. Cards whose `date` differs from the
   snapshots' date are skipped.

### `runJournal(...)` — when it runs

- Called from `server/index.mjs` build path (right after the triage/advisor
  block, fire-and-forget like them) — but **throttled to once per session
  date, and only at/after 15:40 IST** (reuse `inFireWindow`'s IST pattern or
  `marketCloseMinuteFor` from `src/lib/marketSession.ts` — read-only import is
  fine). Signature keeps `readMinute(date, hhmm)` injected so tests inject
  fixtures.
- Resolution walks that date's minute snapshots once (read ascending, resolve
  every unresolved card of that date in a single pass — never re-read per
  card).
- Writes back with the same atomic tmp+rename pattern as the advisor.
- After writing, if any card got a non-`open` outcome today and a
  `send(text)` is provided, send ONE Telegram summary for the day:
  ```
  📓 JOURNAL <date>: 4 resolved — 3 TGT1 (R +1.22 avg), 1 SL, 0 ambiguous
  TMPV 265PE R+1.22 · BANKNIFTY 61600CE R+1.22 · MANAPPURAM 305PE R−1.00 …
  ```
  (one line per resolved card, max 6 lines; day-keyed once-only, in-memory
  set like the advisor's).

## Tests — `server/journal.test.ts` (vitest, no fs, no network)

1. `resolveCard`: bullish card hits TGT1 before SL → status `tgt1`, correct R.
2. Bearish card: SL premium touches first → `sl`, r −1.
3. Same-minute SL and TGT1 → `ambiguous`.
4. No hit → `open` with MFE/MAE numbers.
5. Contract row missing in some minutes → skipped, resolution still works.
6. Cards dated differently from snapshots → untouched.
7. `runJournal` with injected fixtures: resolves once, writes, sends one
   summary; second call same date → no re-send (day-keyed).

## Gates

- `npm test` green (currently 214), `npx tsc --noEmit` clean.
- Existing behaviour untouched: cards without outcomes render exactly as now.

## Explicitly NOT in this phase (parked, Phase 2)

- Calibration table UI, baseline (all-build-ups) comparison, weekly rollups —
  need accumulated outcomes first; the outcome fields here are their input.
- Any UI change, any Jev prompt change, auto threshold tuning.

## Day rollover & history (owner requirement, 2026-11-16)

- **Cards persist.** `observations.json` is never cleared by a restart or a
  new session; the 50-card cap is the only eviction. Cards created today are
  still readable (and shown on the Observations tab) tomorrow.
- **Every card resolves against ITS OWN date's minute snapshots** — a card
  created 2026-11-16 is measured with 2026-11-16 captures, never with the
  next day's prices. A card's entry/SL/TGT levels are today's premiums; they
  are never re-evaluated against tomorrow's market.
- **Unresolved at session end = final `open`.** A card still unsettled at the
  15:40 close (e.g. created at 15:35) gets `status: 'open'` with its MFE/MAE
  from the day it lived in — permanently. It is NOT carried forward as a live
  trade map, and the next day's snapshots must not be used to "finish" it.
  Phase 2 analytics treat `open` as its own bucket.
- **Eviction order:** the 50-cap must never drop an unresolved card before
  its resolution pass has run for that date. Evict resolved cards oldest
  first; if unresolved cards would be evicted, raise the kept-window instead
  (resolve-then-evict is guaranteed because the journal pass runs at 15:40
  the same day, before any new day's cards could push past the cap — keep
  that invariant with a test).
- **Restart-safe:** resolution reads cards from `observations.json`, not from
  memory — a server restart before the EOD pass loses nothing. (The
  already-sent-summary set is in-memory: one duplicate summary after a
  same-evening restart is acceptable, note it in the log.)

## Handoff prompt (paste into Kilo)

> Read `docs/OBSERVATION_JOURNAL_SPEC.md` and implement it exactly: new
> `server/journal.mjs` with the pure `resolveCard` + throttled `runJournal`,
> the once-per-day hook in `server/index.mjs` build path (fire-and-forget,
> after the advisor block), and `server/journal.test.ts` covering the seven
> cases listed plus the Day-rollover rules (per-date resolution, unresolved
> at close = final open, eviction never drops unresolved cards). Do not
> modify strikeAdvisor.mjs, typesafe.mjs, the alert fire path, or any client
> file. Pause when tests pass for verification.
