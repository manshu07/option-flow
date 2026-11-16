# Telegram Subscriber Broadcast — Spec (Phase 1)

**Owner:** Kilo Code (implementer) · Architect/verifier: Qwen · Date: 2026-11-16
**Size:** ~8 SP · **Branch:** `main` (single commit: `feat(subscribers)`)
**Positioning (owner-approved):** free, educational market-data digests only —
no trade calls, no paid tier, no new Dhan data (only what the server already
captures). Every broadcast carries the educational disclaimer.

## Why

The alert engine builds great messages but sends to ONE hardcoded chat id.
Phase 1 opens the same digests to subscribers: anyone who `/start`s the bot
gets the shared alerts. Personal watchlists, quiet hours and observation-card
sharing are Phase 2+ — not here.

## Rule reminders

- Additive only. Do not change rule evaluation logic (`evaluateAlerts`),
  provider code, thresholds, or any client file.
- The owner's chat (`TELEGRAM_CHAT_ID`) keeps receiving everything exactly as
  today, regardless of subscribers.
- Never send observation cards / Jev judgments in broadcasts (Phase 2+ decision).
- Old must work: with zero subscribers, behaviour is byte-for-byte today's.

## Data

- `server/data/subscribers.json` (git-ignored via data dir):
  `{ "subscribers": [{ "chatId": 515497048, "startedAt": 1794…, "active": true }], "offset": 987654 }`
  `chatId` is Telegram's numeric id; `offset` is the getUpdates cursor.
- Cap: **500 subscribers**. Past cap, `/start` replies "full" and does not add.

## New file: `server/subscribers.mjs`

```js
export function loadSubscribers(path) {}          // → { subscribers, offset } (safe on missing/corrupt)
export function saveSubscribers(path, state) {}   // atomic tmp+rename
export function activeChatIds(state) {}           // active === true, as numbers
export async function pollCommands({ token, statePath, now, log, send, handle }) {}
```

### Command polling (getUpdates, no webhook — the Mac has no public URL)

- One pass per call: `GET api.telegram.org/bot<token>/getUpdates?offset=<offset>&timeout=0&allowed_updates=["message"]`
- Advance `offset` to (last update_id + 1) ONLY after the state file write
  succeeds (crash-safe: worst case a duplicate /start, which is idempotent).
- Commands (case-insensitive, allow leading `/`):
  - `/start` → add (or reactivate) `{chatId, startedAt: now, active: true}`,
    reply: welcome + educational disclaimer + "you will receive free daily
    market-data digests (OI spikes, top movers, index levels). Not advice."
    Duplicate /start → friendly "already subscribed", never re-add.
  - `/stop` → `active: false` (keep the entry, keeps their history), reply "stopped".
  - `/help` → the command list + disclaimer.
  - Anything else → one-line hint pointing at /help. Rate-limit replies to a
    chat: max 3 hint messages per chat per hour (in-memory map), else ignore.
- `pollCommands` never throws; all Telegram failures are logged, not raised.

### Wire-up in `server/index.mjs`

- On boot, if `TELEGRAM_BOT_TOKEN` is set: `setInterval(() => pollCommands(...), 5000)`
  (unref'd). Pass the existing `sendTelegram` for replies (to that chatId).
- Guard the whole thing behind try/catch — boot must not depend on Telegram.

## Delivery: broadcast fan-out

- `server/telegram.mjs`: `sendTelegram(text, { chatId, parseMode, retry } = {})`
  — optional override + `parse_mode: 'HTML'` when requested. Keep the current
  no-arg behaviour byte-identical. One retry after 1s on network failure /
  429 (respect `retry_after` if present). Still never throws — returns the
  result object.
- `server/alerts.mjs`: rules gain an optional `"broadcast": true` flag.
  - `evaluateAlerts` stays untouched (it doesn't know about subscribers).
  - `runAlerts` gains `broadcastChatIds = []` (numbers) via options: when a
    message came from a rule flagged `broadcast`, send to the owner AND every
    active subscriber (30 ms gap between sends — Telegram's global limit is
    ~30 msg/s); otherwise owner-only, exactly as now.
- Setup (local, uncommitted file): add `"broadcast": true` to the shared rules
  in `server/data/alerts.json` — `nifty-below-friday-low`,
  `nifty-above-friday-high`, `nifty-oi-spike`, `top-movers-digest`. The
  personal entry/buildup rules stay owner-only (they follow the user's own
  playbook).
- Footer appended to every broadcast copy (not the owner's copy):
  `📊 educational market-data digest · not investment advice · /stop to opt out`
- The journal summary (from `runJournal`) is broadcast the same way — pass the
  active chat ids through its `send`, same fan-out shape.

## Message design + frequency policy (v2 — owner pushback 2026-11-16)

Owner feedback: raw engine lines are hard to read, and repeats every 10
minutes are not wanted. Two fixes, both required:

### A. Frequency: transition, not state

- **Escalating cooldown per rule per day**: after a rule fires, its next
  possible fire is 10 → 30 → 60 min (each fire escalates one step; resets
  next session date). Plus a **daily cap of 6 fires per rule** — after the
  cap the rule is silent until the next session.
- This changes `evaluateAlerts`' cooldown bookkeeping minimally: the state
  map gains per-rule `{ lastAt, firesToday, step }` (same in-memory Map,
  day-keyed counters reset when `market.date` changes). Everything else in
  `evaluateAlerts` stays as-is.
- The 10-min triage keeps making *decisions* internally — it just no longer
  means a Telegram message every 10 minutes.

### B. Batching: one evaluation → one message

- `runAlerts` collects all messages of one evaluation and sends **one
  combined HTML message** with sections, instead of N separate sends:
  ```
  📊 <b>Order Flow</b> · 13:02 IST

  🚨 <b>Level</b>
  • MANAPPURAM 302.10 ↓ 305 (entry zone)

  📈 <b>Build-ups</b>
  • MAXHEALTH +5.16% · OI +2.9M · long
  • KAYNES −14.23% · OI +177% · short

  ⚡ <b>OI spikes</b>
  • 25250PE +988% (114L) · 25300PE +580%

  🎓 educational data · not advice · /stop to opt out
  ```
- Section order fixed: Level → Build-ups → OI spikes → Digest. Skip empty
  sections. Keep the whole message under 900 chars.
- The footer only goes on broadcast copies, never the owner's.

### C. Subscriber cadence

- Subscribers do NOT get instant everything. Broadcast policy:
  - **Instant**: NIFTY level crossings and oi-spike (rare, day-keyed).
  - **Digest**: build-ups and top-movers fold into the next scheduled digest
    — 3 per day at 11:00, 13:00, 15:45 IST (sent by the poll timer, gathered
    from the evaluation results since the last digest).
  - Budget: a subscriber receives at most ~8 messages/day by construction.
- The owner's chat keeps instant everything (with escalation from A).

### D. Formatting details

- All alerts messages move to HTML: bold symbol/label, `•` list lines, escape
  dynamic text with `esc()` (`&`, `<`, `>` first).
- Build-up lines standard shape: `• <b>SYMBOL</b> +5.16% · OI +2.9M · long`.
- Ordering inside one evaluation: Level → Build-ups → OI spikes → Digest.

## Tests — `server/subscribers.test.ts` (vitest, injected send, no network)

1. `/start` adds a subscriber, replies welcome; duplicate `/start` is idempotent.
2. `/stop` deactivates (entry kept); `/stop` for unknown chat is a no-op reply.
3. Cap: at 500 subscribers `/start` replies full and does not add.
4. `offset` advances only after a successful save (simulate a save throw —
   offset must not advance).
5. Broadcast fan-out: rule flagged `broadcast` + 3 subscribers → owner + 3
   sends (injected `send` records chat ids); non-broadcast rule → owner only.
6. Zero subscribers → identical single-send behaviour as today.
7. HTML escaping: a label containing `<` renders escaped in the payload.
8. `pollCommands` never throws on a Telegram 502 (injected fetch rejects).
9. Escalating cooldown: 2nd fire of a rule inside 10 min is blocked; after a
   30-min-old fire the gate widens; 6th fire of the day is capped.
10. Batching: 3 messages in one evaluation arrive as ONE `send` with the
    Level/Build-ups/OI-spikes sections in order; empty sections are skipped.
11. Subscriber digest: build-up messages between digests queue and go out as
    one message at the digest time; NIFTY level crossing goes out instantly.

## Gates

- `npm test` green, `npx tsc --noEmit` clean.
- With zero subscribers, every existing message behaves byte-for-byte as now.

## Explicitly NOT in this phase (parked)

- Personal watchlists (`/watch …`), quiet hours, per-subscriber thresholds.
- Webhook mode, retry queues beyond the single retry, admin /stats.
- Observation-card broadcasts, Jev quality numbers to subscribers.
- launchd 24/7 hosting (prerequisite before advertising the bot to anyone).

## Handoff prompt (paste into Kilo)

> Read `docs/TELEGRAM_SUBSCRIBERS_SPEC.md` and implement it exactly: new
> `server/subscribers.mjs` (registry + getUpdates command polling with the
> crash-safe offset rule), the boot wire-up in `server/index.mjs`, the
> broadcast fan-out in `server/alerts.mjs`/`server/telegram.mjs` with HTML
> formatting and the educational footer, and `server/subscribers.test.ts`
> covering the eight cases listed. Add `"broadcast": true` to the four shared
> rules in the local alerts.json. Do not change evaluateAlerts logic, provider
> code, thresholds, or any client file. Rulebook applies: additive only, old
> single-chat behaviour byte-identical with zero subscribers. Pause when tests
> pass for verification.
