# Next-day watchlist in the 15:45 EOD — spec (owner-approved 2026-11-18)

**Owner's ask:** "Telegram didn't send next day plan or watchlist as we decided." The
EOD that landed was fully backward-looking (Top movers / Build-ups / Wall shifts /
Gamma unwinds / Levels touched + Decision tally + Observations). Nothing carried
today's structure into tomorrow.

**Owner decisions:** audience **sabko same** (subscribers get the same plan as the
owner — confirmed despite the trade-call caveat), timing **inside the 15:45 EOD as
its own message** (does not eat the 900-char event/journal budgets).

**Content rule:** data-level triggers only — bias read, close, day change, chain OI,
CE/PE walls. No entry/SL/target prescriptions, no Jev/model/advisor wording
(audience rule). Footer + educational disclaimer as on every broadcast.

**Files:** `server/alerts.mjs`, `server/index.mjs`, `server/alerts.test.ts`. No
provider, journal, advisor or client changes. No new endpoints or timers.

---

## W1 — `nextDayPlanMessage(market, dailyEvents, date)` (alerts.mjs)

- Candidates: symbols that fired a **buildup** event today (`digestState.dailyEvents`
  where `rule.type === 'buildup'`), ranked by `|oiPct|` from `marketMovers(market)`;
  cap **5**. Fallback when no buildups fired today: top 3 movers by `|oiPct|`.
- Per symbol (from the market series rows): spot close, day change %, chain OI %,
  nearest CE wall above spot, nearest PE wall below spot (strike + OI, compact M/K).
- Line shape: `• <b>TMPV</b> LONG · close 259.6 (+5.2% · OI +8.1%) · walls 300 CE / 260 PE`
  — pieces dropped individually when unavailable; symbol skipped when the series is
  missing.
- Message: `🎯 <b>Next-day watchlist</b> · {next session date}` + lines +
  `BROADCAST_FOOTER`, bounded to 900 chars. Next session date skips Sat/Sun (IST).
  **null when no lines** — no empty plan message.

## W2 — Delivery (flushScheduledDigests + index.mjs)

- `flushScheduledDigests` gains `planMarket = null` and `ownerChatId = null` options.
  In the 15:45 slot, `messages.push(plan)` before the subscriber loop when the plan
  message is non-null — so subscribers receive EOD sections, journal, then the plan
  as the final message.
- Owner parity ("sabko same"): the plan message is also sent to `ownerChatId` once
  (owner never receives the rest of the EOD — that stays subscriber-only).
- `index.mjs` passes `planMarket: state.latest` and
  `ownerChatId: process.env.TELEGRAM_CHAT_ID ?? null`.

## W3 — Tests (alerts.test.ts)

1. Builder ranks by `|oiPct|`, renders walls from rows, skips a symbol with no
   series, falls back to top movers when no buildups fired, returns null on empty.
2. 15:45 flush sends the plan as the LAST message to the subscriber and once to the
   owner chat; plan text has the heading, a symbol line, and the footer; no model
   words (`/jev|quality|advisor|watch probability/i`).
3. No candidates → no plan message, sent-count unchanged for it.
