# Observation card v3 — expiry, timestamp, plain regime, theta — Spec

**Owner:** Kilo Code · Architect/verifier: Qwen · Date: 2026-11-17 · ~3 SP
**Owner's demand (verbatim):** "we have to add this in the card. that my point." —
plain regime wording, expiry month/DTE, date+time stamp, premium-decay (theta)
handling, newest-first.

**Files:** `src/features/observations/ObservationsPage.tsx`,
`server/observationCardSvg.mjs` (Telegram caption), `src/features/observations/observationModel.ts`
(sort helper) + their tests. No other files.

## S1 — Header shows expiry + DTE
Card header becomes:
`DELHIVERY 455CE · 23-Nov (6 DTE) · bullish · quality 93%`
- Expiry from `card.expiry` (YYYY-MM-DD → "23-Nov"), DTE = calendar days from
  the card's date to expiry (never from view time for historical cards; use
  `card.date`).
- Same fields in the Telegram caption.

## S2 — Timestamp with date, time and age
Replace the time-only stamp with:
`17-Nov · 14:52 IST · 1h ago`
- Date + time from `card.at` in IST. Age = now − card.at, rendered as
  "4m ago" / "1h ago" / "2d ago"; re-render with the page's existing 30s poll
  (no new timer).
- Telegram caption: `17-Nov 14:52 IST` (static, no age).

## S3 — Plain regime wording (replace the jargon line)
Replace `Γ regime: long · flip 1480` with a plain sentence:
- gamma-long: `📐 Dealer flow: RANGE above 1,480 — breakouts likely to fade`
- gamma-short: `📐 Dealer flow: TREND below 1,480 — moves can accelerate`
- No flip (null): omit the line.
Numbers still shown; jargon "Γ regime" removed from the UI and caption.

## S4 — Theta awareness
When DTE ≤ 7 add one line to the card and caption:
`⏳ 6 DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.`
When DTE ≤ 2, strengthen: `⏳ 2 DTE — expiry-week decay is brutal; treat as a
same-day trade only.`
When DTE > 7: no theta line (nothing to warn).

## S5 — Newest first
The list renders cards sorted by `at` descending (newest call first), then by
creation order for same-timestamp batches. Sorting lives in
`observationModel.ts` as a pure `sortObservationCards(cards)` + test. The
stored file order is not changed.

## Tests
- `observationModel.test.ts`: sort newest-first, stable within equal timestamps.
- `ObservationsPage.test.tsx`: header contains expiry + DTE; timestamp shows
  date and age; plain regime sentence (no "Γ regime" string anywhere);
  theta line appears at DTE 6 and not at DTE 20.
- `observationCardSvg.test.mjs`: caption contains expiry, dated timestamp,
  plain regime, theta line.

## Gates
`npm test` green (287 baseline + new), `npx tsc --noEmit` clean. No new
endpoints, no new timers, journal/advisor logic untouched.