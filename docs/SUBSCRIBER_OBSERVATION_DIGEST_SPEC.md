# Subscriber observation digest — stripped, no attribution — Spec

**Owner decision 2026-11-17:** subscribers SHOULD receive observation-card
signals, but **must never see that Jev or any model decided them**
("they cant see the decision is taken by Jev. esa message nahi ana chahiye").
So: stripped cards, no quality score, no "watch", no model/agent words —
presented as plain captured-data observations.

**Files:** `server/alerts.mjs` (digest append), `server/observationCardSvg.mjs`
(stripped caption helper), plus their tests. Nothing else.

## S1 — Stripped caption (new helper)
`observationSubscriberCaption(card)` in `observationCardSvg.mjs`:
```
📌 <b>DELHIVERY 455CE</b> · 23-Nov (6 DTE)
Entry ~₹8.15 · SL ₹4.48 · TGT1 ₹12.63 · TGT2 ₹15.49
🎓 captured-data observation · not investment advice · /stop to opt out
```
Rules:
- No quality score, no probability, no "Jev", no "watch", no "advisor",
  no "AI/model" wording — anywhere in the text.
- Same numbers as the card (entry/sl/tgt1/tgt2), expiry + DTE, disclaimer.
- Extra parenthetical when relevant: pin note and stop-beyond-flip note may be
  included, but reworded with no attribution ("expiry-week pin zone",
  "stop beyond dealer flip zone").

## S2 — Digest section
In `flushScheduledDigests` (the 11:00 / 13:00 / 15:45 flush), append a new
section at the END of the combined message:
`📌 <b>Observations</b>` with up to **3 newest** cards written since the last
digest (by card.at), each as one stripped line:
`• <b>SYMBOL K SIDE</b> · 23-Nov · entry ₹8.15 · SL ₹4.48 · TGT1 ₹12.63`
- Source: read `observations.json`, filter cards with `at > lastDigestAt` and
  `outcome` absent; cap 3; newest first. Track `lastDigestAt` in the digest
  state (day-keyed).
- Skip the section entirely when no new cards.
- Keep the existing 900-char budget: if the section would overflow, drop the
  oldest observation lines first (observations go last by design).
- Never broadcast: quality, probabilities, or any model attribution.

## S3 — Owner messages unchanged
The owner's card message (full v2 template) and any owner digest behaviour stay
exactly as today. This spec only adds the subscriber copy.

## Tests
- `observationCardSvg.test.mjs`: stripped caption has no "quality", no "Jev",
  no "watch" strings; contains expiry/DTE/entry/SL/TGT1 and disclaimer.
- `alerts.test.ts`: flush appends the Observations section with up to 3 new
  cards since lastDigestAt, newest first; section absent when no new cards;
  no attribution strings in the final broadcast text.
- Owner copy test: unchanged full-quality text still produced.

## Gates
`npm test` green, `npx tsc --noEmit` clean. No new endpoints/timers.
Do not touch `journal.mjs`, `typesafe.mjs`, provider code, or the owner card
template beyond sharing helpers.