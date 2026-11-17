# Pull-first Telegram — spec (owner-approved 2026-11-17)

**Owner's model, verbatim intent:** "Users ko sirf ye observation hi bhejte he
in detailed and on demand. if they subscribe any instrument then uska bhi
jayega. agar puchega to about any strike or OI specific then we can give
otherwise why we have to share?"

Translation to behaviour: Telegram becomes **pull-first**. The bot stops
broadcasting observations on a schedule. Subscribers ask and get; they
subscribe to instruments and get those instruments' events; everything else is
silent.

**Files:** `server/subscribers.mjs`, `server/alerts.mjs`, `server/index.mjs`,
plus tests (`server/subscribers.test.ts`, `server/alerts.test.ts`). No other
files. No new endpoints, no new timers, journal.mjs/typesafe.mjs untouched.

---

## What stays (unchanged behaviour)

- Owner chat: everything as today (alerts, digests it opts into, journal
  summary, full-quality cards).
- Personal alerts: `/alert SYMBOL above|below LEVEL` fires instantly as today.
- oi-spike instant broadcast: stays (one per day, rare, useful) — broadcast
  rule `nifty-oi-spike` keeps `broadcast: true`.
- Full detail always lives in the app (8787 Observations tab). Telegram is a
  nudge, not the product.

## What goes away (the noise)

- Scheduled 11:00 / 13:00 digests: `DIGEST_MINUTES` shrinks to the single
  **15:45 EOD slot**. That one daily message keeps: build-ups/top-movers/
  wall-shift events of the day, the journal tally, and the Observations
  section (max 3 newest cards) — everything already implemented, just once a
  day instead of three.
- Auto observation-card pushes to subscribers: the `/obs` command replaces
  them (`lastDigestAt` tracking stays for the EOD section).
- EOD broadcast dedupe: `eodBroadcasts` unchanged; only the delivery count
  drops naturally when slots shrink.

## S1 — Pull commands (subscribers.mjs)

`pollCommands` gains a `context` object passed from index.mjs:
`{ getMarketJson: () => string | null, getObservations: () => card[] }`.
All commands answer from these — zero new fetches.

Commands (owner + active subscribers; unauthenticated chats get the standard
subscribe hint):

- **`/live SYMBOL`** — one compact HTML block:
  `TMPV · spot 259.6 (−8.1%) · build: SHORT · CE wall 300 (11.8M) · PE wall
  260 (5.9M) · IV 21.4%`
  Data: latest market file series for the symbol + day-floor build read.
  Unknown symbol or missing spot → one honest line.
- **`/obs SYMBOL`** — that symbol's newest observation cards (max 3), rendered
  with `observationSubscriberCaption` (stripped, no attribution). No cards →
  "no observations for SYMBOL yet".
- **`/oi SYMBOL [STRIKE]`** — top OI strikes for the symbol:
  `CE walls: 300 (11.8M +32%) · 290 (…)` / `PE walls: 260 (5.9M +112%) …`
  With an optional strike argument: that strike's CE and PE rows (ltp, OI,
  day change).
- Rate limit: reuse the existing per-chat hint limiter (3 per hour) for these
  commands too.
- Every reply keeps the educational disclaimer line.

## S2 — /watch + /unwatch (personal instrument subscription, S)

- **`/watch SYMBOL`** → adds two personal rules for that symbol (type
  `buildup` + a wide level band is NOT added — buildup only; levels stay
  manual via /alert). Stored in the subscriber's `alerts` array with
  `type: 'buildup'`; the per-subscriber evaluation already supports buildup
  rules via the shared evaluator.
- **`/watch` alone** → lists watched symbols. **`/unwatch SYMBOL`** → removes.
- Cap: 10 watched symbols per subscriber (same style as MAX_PERSONAL_ALERTS).
- The advisor's observation cards become per-subscriber opt-in naturally:
  a subscriber who watches SYMBOL receives that symbol's observation lines in
  digests; others do not. (Digest Observations section filters by the union of
  all subscribers' watched symbols — computed cheaply from the subscribers
  state; symbols nobody watches are still written to observations.json for
  `/obs` and the web page, they just stop appearing in digests.)

## S3 — index.mjs wiring

- Build loop already has `state.latest` and `loadObservations(...)`; pass
  `{ getMarketJson, getObservations }` into `pollCommands` options (plain
  closures, no new timers — the 5s poll loop exists).

## S4 — Digest slim-down

- `DIGEST_MINUTES` → `[15 * 60 + 45]` only (EOD). The Observations section,
  journal tally and the day's events all move into that single 15:45 message.
- Tests that relied on 11:00/13:00 slots get their clock moved to 15:45 IST.

## Tests (vitest, injected context, no network)

1. `/live TMPV` returns spot, build read and walls from the injected market
   JSON; unknown symbol → honest line; 6th call within 10 min → rate-limit
   reply.
2. `/obs TMPV` returns the symbol's stripped observation lines (from injected
   store), max 3, no attribution words.
3. `/oi TMPV 265` returns that strike's CE/PE rows plus the walls.
4. `/watch SYMBOL` adds a personal buildup rule that the shared evaluator
   fires on a qualifying market file; `/unwatch SYMBOL` removes it.
5. EOD-only digest slot: dueSlots at 11:00 IST returns `not due`; at 15:45 IST
   flushes the day's pending events + observations in one message.
6. Unknown command still gets the hint; owner chat bypasses subscription
   checks.

## Gates

`npm test` green (335 baseline + new), `npx tsc --noEmit` clean,
`npm run build` clean. No new endpoints, no new timers, no journal/advisor
logic changes. With zero commands typed, behaviour is today's except the two
removed digest slots.

## Parked (explicitly)

- December (next-expiry) capture per docs/DECEMBER_EXPIRY_SPEC.md — separate
  handoff, do not implement here.
- Inline buttons, Hindi toggle, webhook mode.

## Handoff prompt (plain English, paste into Kilo)

> Read docs/TELEGRAM_PHASE2_SPEC.md only for the existing command infrastructure,
> then implement docs/PULL_FIRST_TELEGRAM_SPEC.md exactly: convert the bot to
> pull-first (S1 pull commands /live /obs /oi with the injected context and
> rate limits, S2 /watch and /unwatch personal instrument subscriptions capped
> at 10, S3 index.mjs context wiring, S4 digest slots reduced to the single
> 15:45 EOD slot). Subscribers must never receive scheduled observation pushes
> again — only their own personal alerts, the daily oi-spike broadcast, and the
> one 15:45 EOD report. Do not touch journal.mjs, typesafe.mjs decision logic,
> provider code, or any client file. Add the listed tests. Gates: npm test,
> npx tsc --noEmit, npm run build all clean. Pause and report when done.