# P0 accuracy spec — measure, then fix the card levels, then calibrate quality

Owner-approved direction (2026-11-18, "kaha kam krna chaiye… accuracy" audit):
accuracy work starts from P0 in this order. One story per commit.

Files: `server/journalStats.mjs` (new), `server/journalCommand.mjs`,
`server/strikeAdvisor.mjs`, tests. No provider changes in S1; S2 touches only the
advisor's level/liquidity logic; S3 only the quality question/scale.

---

## S1 — Per-signal accuracy analytics (this batch)

**Why:** the journal prints one flat day tally; nothing shows which card type
(early vs model, ORB ✓ vs ✗, side, DTE) actually hits TGT1. Everything below
depends on this measurement existing.

### API (`server/journalStats.mjs`, pure)

`signalStats(cards, { minSample = 1 } = {})` → array of buckets:

```js
{ key, label, cards, resolved, tgt1, sl, ambiguous, open, winRate, avgR }
```

- `resolved` = tgt1 + sl + ambiguous (an outcome exists; open/no-outcome excluded)
- `winRate` = tgt1 / resolved (null when resolved = 0) — ambiguous counts as loss
- `avgR` = mean of `outcome.r` over resolved cards that carry a finite r (null when none)
- Buckets (a card may appear in one bucket per family):
  - **signal:** `early-momentum`, `early-build-fast`, `model` (quality ≥ 0.65), `model-low` (quality < 0.65 & not early, legacy)
  - **ORB:** `orb-yes` (`strategy.qualifies === true`), `orb-no` (`=== false`), `orb-none` (no tag / pre-073 cards)
  - **side:** `ce`, `pe`
  - **DTE:** `dte-0-3`, `dte-4-7`, `dte-8-plus` (from `card.date` → `card.expiry`, IST 15:30)
- Sorted by resolved desc, then cards desc; drop buckets below `minSample`.

### Wiring

- `journalCommand` (`/journal`) appends a `📊 By signal` section under the day
  tally: top 3 signal buckets + ORB yes/no, each
  `• <label>: <cards> cards · <tgt1> TGT1 · <sl> SL · win <pct> · avg R <±x.xx>`,
  inside the 900-char budget; omitted when there are no resolved cards.
- `scripts/journalStats.mjs` CLI prints the full table for a date range
  (`node scripts/journalStats.mjs [fromDate] [toDate]`) — offline, reads
  observations.json only.

### Tests (`server/journalStats.test.ts`)

1. mixed cards: early momentum / early build-fast / model produce correct counts,
   winRate and avgR per bucket, open cards excluded from resolved.
2. ambiguous counts as a loss; cards without outcome are `open`.
3. DTE buckets from date→expiry; missing expiry lands nowhere (skipped).
4. ORB buckets: qualifies true/false/absent.
5. minSample drops thin buckets; empty input → [].

Gates: `npm test`, `npx tsc --noEmit`, `npm run build` clean.

---

## S2 — ATR/delta-aware levels + liquidity gate (next batch)

**Delivered 5ed5ce2.** Levels use futures ATR × captured delta (per
`docs/ATR_RANGE_SPEC.md` r2 — the option's own premium ATR ratio was rejected);
gate shipped as OI ≥ 10k, day volume ≥ 1k, spread ≤ 2% of mid.

- Replace fixed `STOP_FRACTION`/`TGT1_FRACTION`/`TGT2_FRACTION` % of premium as the
  default: `sl = entry − k·ATR_premium`, `tgt = entry + k·ATR_premium` where
  `ATR_premium` comes from the option's own minute premium series (fallback:
  underlying ATR × captured delta when the premium series is thin; label the
  approximation).
- `candidateStrikes` gains a liquidity gate: bid–ask spread ≤ 2% of mid, OI ≥
  50k, day volume ≥ 10k (skips dust strikes, keeps ATM ±2 window).
- Tests: synthetic chains assert skipped thin strikes; ATR-based levels on a
  fixture with known premium ATR.

## S3 — Jev quality scale recalibration (after S2)

**Delivered.** Question now asks for 0–100 with confidence anchors;
`normalizeQuality()` maps 0–100 → 0–1 (auto-detects `>1`, `ADVISOR_QUALITY_SCALE=1|100`
pins the scale), non-numeric answers count as `unknown` and skip. Skip reasons
print `quality 45%` / `quality unknown`.

- The quality question returns 0.12–0.20 per pass against a 0.65 gate while
  triage watch reads 0.5–0.7 — the scale is mismatched.
- Change the question to an explicit 0–100 score with anchors
  (90+ = clean build-up + walls aligned + liquid; 50 = mixed; <30 = noise) and
  divide by 100 in `advisorDecisions`; keep the env override
  `ADVISOR_QUALITY_SCALE=100|1` so a bad scale can be reverted without a code change.
- Success measure (uses S1): model bucket win-rate should exceed early-momentum
  bucket win-rate over two weeks; if not, the gate is still mis-scaled.

## Parked

- VWAP/PDH-PDL/sector ORB scanner (P1), gamma stock validation (P1),
  cross-expiry participation (P1), NSE/BSE tabs + ops (P2).