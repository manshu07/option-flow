# MCX_LIGHT_SPEC — evening watchlist + level alerts (Batch-6, FULL-BATCH MODE)

Owner went to sleep 2026-11-24 00:4x IST. **FULL-BATCH MODE (this time only):** implement ALL
stories M1→M3 in ONE continuous run tonight. Per-story commits ARE required (feat(mcx): M1 …),
but you DO NOT pause between them, and you DO NOT wait for architect review — the architect
verifies the whole batch in the morning. Every question you might have is pre-answered below in
EDGE CASES — if you hit a case not listed there, make the conservative choice (skip + log once)
and note it in the final summary; do not stop to ask.

Owner scope (fixed): GOLD, SILVER, NATURALGAS, GOLDM, SILVERM, NATURALGASM — futures only.
No option chains, no cards, no advisor, no journal for MCX in this batch.

## RULE 0 — READ-FIRST

Read these files end-to-end before coding (grep anchors given):
1. `server/index.mjs` — `sendOwnerAndSubscribers` helper, the market rebuild pass (where
   `checkLevelHits` is called), `isTradingDay` gate pattern, `DATA_DIR` usage.
2. `server/alerts.mjs` — the digest day-latch + silent-mark pattern (S: window-passed) you
   will mirror for the MCX fired-levels latch.
3. `server/providers/dhan.mjs` — quote REST usage (`.env` token + client-id pattern).
4. `src/lib/marketSession.ts` — `istDateKey` / IST arithmetic patterns (reuse, don't reinvent).
5. `server/journal.test.ts` — test style reference (ESM imports; never require).

After reading, state one line per file you WILL touch. Anything outside the map → the
conservative choice is to NOT touch it; note it in the final summary instead.

## Confirmed facts (already proven — do not re-verify, do not re-derive)

- Segment key for the quote API is **`MCX_COMM`** (probe 2026-11-24 00:5x returned live prices
  + OI for all 6 contracts; the key `M` returns an empty success — known Dhan trap).
- securityIds (near futures, from `docs/mcx-spike-contracts.json`): GOLD 495213, SILVER 495214,
  NATURALGAS 574319, GOLDM 575011, SILVERM 483080, NATURALGASM 574320.
- Quote endpoint: POST `https://api.dhan.co/v2/marketfeed/quote`, headers `access-token` +
  `client-id` from `.env`, body `{"MCX_COMM":[ids]}`. An empty `{"data":{},"status":"success"}`
  means wrong segment/id — treat as "no data this poll", log once, never crash.
- Token may expire (~24h validity): an expired-token response is handled like empty — skip the
  poll, log once per hour max. DO NOT implement token refresh (out of scope; owner rotates it).

## M1 — MCX evening watchlist brief (owner-only)

- New module `server/mcx.mjs` exporting `mcxWatchPoll(now)` + `mcxEveningBrief(now)` (pure-ish:
  fetch inside, but all decisions testable).
- Session window: Mon–Fri, 09:00–23:30 IST (**env `MCX_CLOSE_MINUTE`, default 23*60+30** —
  winter/summer switch is a manual env change, documented, not auto-detected). Weekends skip.
  Holidays: reuse `isTradingDay` for the NSE list as the base gate (known limitation: MCX-only
  holidays not covered — accepted in this batch, logged in the spec's limitations).
- Poll: every 60s, ONLY inside the window — one POST quote call for all 6 ids.
- Evening brief: ONE message per day at 21:00 IST (day-keyed latch, file-persisted, see M2):
  per symbol one line — `GOLD 126,021 (prev 125,996, +0.02%) · OI 9,748 · H 126,041 L 125,900`.
  Sent to OWNER only (`sendOwnerAndSubscribers` is wrong here — use the owner-only send path
  used by the token watch reminder; grep `owner sent` for the existing helper). Subscribers are
  NOT included (env `MCX_BRIEF_SUBSCRIBERS=1` opts in later — default off).
- Latch persisted to `<DATA_DIR>/mcx-brief-state.json` `{dayKey, sentBrief: true, fired: {...}}`
  (sync fs, one small file). Restart at night must NOT re-send: on load, if `dayKey` is today,
  restore state; if the file's dayKey ≠ today, start fresh.

## M2 — MCX level alerts (owner + subscribers, no OI in text)

- Levels file: `<DATA_DIR>/mcx-levels.json` — `[{ "symbol": "GOLD", "label": "breakout",
  "price": 127000, "dir": "up" }, { "symbol": "SILVER", "label": "support", "price": 150000,
  "dir": "down" }, …]`. The file may not exist yet — then M2 is a silent no-op (log once per
  day). Owner creates/edits levels by editing the file; document that in the final summary.
- Crossing rule: `dir: up` fires when `last_price >= price`; `dir: down` fires when
  `last_price <= price`. Each entry has a unique `label+symbol` key — fires ONCE per day
  (latched in the same persisted state file). After firing, the entry is skipped for the rest
  of the day even if price re-crosses.
- Message: `📊 MCX GOLD breakout — price 127,050 crossed 127,000 (up) · 21:14 IST` — premium/
  price/level/time only. **No OI anywhere in the message text** (owner rule). Send via
  `sendOwnerAndSubscribers` (owner + subscribers both get this one).
- Never fire outside the session window. Never fire more than one alert per symbol per poll.

## M3 — Tests + gates

- Vitest for: window guard (fires inside, silent outside), latch persistence (write state,
  re-load, no double-fire), crossing rules (up/down/edge-equal), brief day-latch, expired-token
  poll skip. Mock `fetch` in tests (no network).
- Gates: full `npx vitest run` (exact counts) + `npx tsc --noEmit` + `npm run build`.
- Do NOT restart the service. Do NOT edit `.env`. Do NOT touch `server/journal.mjs`,
  `server/strikeAdvisor.mjs`, `.fast/`, `scripts/h6rs*`.

## EDGE CASES — pre-answered (do not ask)

| Case | Behaviour |
|---|---|
| Token expired | skip poll, log once per hour, no crash |
| Dhan empty success | skip poll, log once per hour |
| Dhan 429 | skip poll (60s cadence is already gentle), log once |
| Weekend / NSE-listed holiday | no poll (isTradingDay gate) |
| Poll at 23:31+ | outside window, skip |
| Symbol missing from quote response | skip that symbol this poll |
| `mcx-levels.json` missing | M2 no-op, log once per day |
| Level entry malformed | skip entry, log once |
| Server restart mid-evening | persisted state restores — no re-fire, no re-brief |
| OI missing in a response | brief line shows `OI —` |
| `sendOwnerAndSubscribers` fails | log, continue with remaining alerts |
| Midnight rollover (session ends before midnight) | window end 23:30 makes this moot |

## LIMITATIONS (accepted this batch, stated in final summary)

- MCX-only holidays not covered (NSE list is the base gate) — an MCX-open/NSE-closed day
  produces no brief (miss, not spam — conservative direction).
- Summer close 23:55 needs a manual `MCX_CLOSE_MINUTE` change.
- Levels come from a hand-edited file — no UI in this batch.

## VERIFICATION PROTOCOL (per story + final)

1. Runtime evidence: the vitest run output + one manual `mcxWatchPoll` invocation output with
   real prices (evening session is live while you work — use it).
2. Whole-file re-read of every changed file after the change.
3. Call-site audit: grep every new export's consumers.
4. Full suite + tsc + build, exact counts.

## RESUME CHECKLIST (if the work stops midway)

1. `git log --oneline -6` + `git status --short` — which M-commits landed, which files dirty?
2. Which story's gates last ran green? A story without its acceptance evidence is NOT done.
3. Full suite now: note exact failures. `npx tsc --noEmit`.
4. Strays: `ps aux | grep mcx` — kill only probes you started.
5. Re-read the spec + the current file state of the story you resume (never resume from memory).
6. Continue from the next unchecked gate. Never re-commit a story with existing evidence.
