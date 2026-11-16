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

## Message formatting (quality pass)

- Alerts messages move to HTML: bold the symbol/label
  (`🚨 <b>MANAPPURAM entry zone</b> …`), keep the rest plain. Escape any
  dynamic text with a tiny `esc()` helper (`&`, `<`, `>` first).
- Ordering inside one evaluation: entry-zone/level messages first, then
  build-ups, then oi-spike, then digest (sort in `runAlerts` before sending —
  evaluation order already roughly does this; make it explicit).
- Keep every message under 800 chars (Telegram's 4096 limit is generous, this
  keeps digest+NIFTY combined days readable).

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
