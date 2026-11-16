# Telegram Phase 2 — commands, richer digests, 24/7 hosting — Spec

**Owner:** Kilo Code (implementer) · Architect/verifier: Qwen · Date: 2026-11-16
**Base:** subscriber broadcast already landed (`f87496e`/`f3ddfa5`) — registry,
command polling, fan-out, digest queue, escalating cooldowns all exist. This
spec ADDS on top. Implement the stories in the order given; pause after each
story's tests pass (per-story commits).

**Positioning unchanged:** free, educational, same captured Dhan data, no
trade calls, disclaimer on every message, observation cards stay owner-only.

## Shared infra notes (read first)

- Command dispatch lives in `server/subscribers.mjs` `pollCommands` — extend
  `commandFor` with the new commands; unknown-command hint stays.
- Message building = same HTML conventions (`esc()`, `•` bullets, <900 chars,
  fixed section order, footer only on broadcast copies).
- Market data for answers comes ONLY from what the server already has:
  `provider.spots()`, `provider.ticksFor()`, the latest market file
  (`/api/market` state), stored minute snapshots, and journal outcomes in
  `observations.json`. No new Dhan endpoints.
- Every new user-facing message carries the disclaimer.

## S1 — launchd 24/7 auto-start (ops prerequisite, M)

`scripts/com.order-flow.dev.plist` + installer instructions in the spec
output: LaunchAgent that runs `npm run dev` (or a dedicated
`npm run start:dhan`) at load, `KeepAlive` with `ThrottleInterval: 30`,
logs to `server/data/logs/`. Add `npm run service:install` /
`service:uninstall` scripts (thin wrappers around
`launchctl bootstrap gui/$UID …`). Do NOT auto-install — the plist + scripts
land; the owner runs install himself. Acceptance: after `launchctl kickstart`,
the API answers on 8787 and the tree survives a manual `kill`.

## S2 — `/live SYMBOL` (M)

Any active subscriber asks for an instant snapshot. Reply (HTML):
spot + day change, futures LTP, build-up read (day floors), nearest CE/PE
walls with OI, top OI-gaining strike on the asked side. Unknown/unsupported
symbol → honest one-liner. Rate limit: 5 `/live` per chat per 10 min.
Data: latest market file series + `provider.spots()`/`ticksFor()`.
Sub-only? No — the owner gets it too (same handler).

## S3 — `/journal` (S)

Today's resolved observation-card outcomes on demand: status/R per card +
day tally (`X TGT1 · Y SL · Z open`). Reads `observations.json` outcomes.
Empty → "no outcomes resolved yet today".

## S4 — EOD report at 15:45 (M)

Extend the existing 15:45 digest slot into a full report for subscribers:
top movers (already queued), build-ups of the day, levels touched today
(from the alert state's fired list — track fired rule ids per day in the
digest state), journal outcomes (from observations.json outcomes), Jev tally
(cards written, hit counts — numbers only, no quality values). One message;
if >900 chars, split into two (report + journal). Owner keeps instant
messages as today.

## S5 — personal price alerts `/alert SYMBOL above|below LEVEL` (M→L)

Per-subscriber rules: `/alert MANAPPURAM above 320`, `/alerts` (list),
`/unalert ID`. Stored in a new `alerts` array on the subscriber entry.
Evaluated each build against the latest market file (sp), owner-style
message + footer. Budget: 10 alerts/subscriber, 5 fires/alert/day (the
escalating cooldown applies per alert). Level/buildup engine logic reused —
do not fork `evaluateAlerts`; wrap it (temp rules list per subscriber
evaluated in the same pass, sent only to that chatId).

## S6 — OI wall shift alerts (M)

New broadcast rule type `wall-shift`: when the heaviest CE above spot or PE
below spot for a watched symbol CHANGES strike (wall moved) or its OI
crosses ±25% day change, emit one line. Watched set = broadcast build-up
symbols of the day + NIFTY/BANKNIFTY. Fold into digests (not instant).
Data: compare today's walls against the day's first captured walls (store
the baseline in the digest state at first evaluation).

## S7 — gap-open alert at 09:20 (S)

Once per day at 09:20 IST: if NIFTY/BANKNIFTY/SENSEX spot is beyond
Friday-close ±1% (i.e., a real gap), one instant message to owner +
subscribers: `🌅 NIFTY gap-up +1.2% vs Friday close 25144`. Data: latest
market file at 09:20 + prev close from the same file. Skip silently if no
capture exists yet.

## S8 — weekly review, Friday 15:50 (M)

Friday-only extra message after the 15:45 digest: week's journal roll-up
(cards written, TGT1/SL/open counts, avg R, best and worst card by R) read
from observations.json outcomes across the last 5 session dates. Owner +
subscribers. Skip if fewer than 3 resolved cards exist in the window
(sample-size honesty).

## Parked (explicitly NOT in this batch)

- Stripped observation-card digest to subscribers (needs the owner's final
  call — advice-adjacent).
- Inline keyboard buttons, `/watch` personal watchlists, quiet hours,
  Hindi toggle, deep-link tracking, retry queue.
- Order placement. Always parked.

## Gates per story

- `npm test` green (250 baseline + your new tests), `npx tsc --noEmit` clean.
- Zero-subscriber behaviour: broadcasts unchanged; owner unchanged except new
  commands.
- No new Dhan REST calls outside market hours (the provider now gates its
  loops on `isMarketSessionTime` — do not add un-gated timers).

## Handoff prompt (paste into Kilo)

> Read `docs/TELEGRAM_PHASE2_SPEC.md` and implement the stories in order
> S1 → S8, one commit per story, pause after each story's tests pass.
> Reuse the existing command poller, fan-out, digest state and message
> conventions; data only from what the server already captures; disclaimer
> everywhere; no new Dhan endpoints or un-gated timers. Note: the provider's
> rebalance/seed loops are now market-hours gated — keep it that way. Pause
> for verification after each story.
