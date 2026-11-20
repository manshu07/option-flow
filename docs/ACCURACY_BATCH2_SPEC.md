# ACCURACY BATCH 2 SPEC — regime-conditional report, SL-width backtest, PCR display, underlying-anchored SL, sector cap

Status: APPROVED 2026-11-20 (owner: "Complete above with specs. then I will give to test this time to kilo to test"). r1.

Owner goal: **fewer SL hits, better target selection, green close**. Measured baseline
(92 cards, Nov 18-20): 17 SLs — ALL in RANGE regime; PCR rising >3% bucket −2.00R;
TGT2 hit 1/95; win-rate 26%.

## Already LIVE (do not re-implement)

- Trend gate, premium confirmation gate, opening-chop gate (a4a5822 + 2f362e8)
- PCR-shift gate + PCR session history (2c5f436 + 955a416, live since the 15:45 restart)
- Regime gate (range-regime early cards skipped) — same commit set
- ₹0.05 tick snapping, RE-ENTRY cards, zone tints

## S1 — regime-conditional wins report (read-only script) — 2 pts

`scripts/regimeWins.mjs` — cross-tab every stored card by **signal bucket × regime × outcome**.

- Input: `server/data/observations.json` (all dates in the store).
- Cross-tab rows: per (bucket ∈ early-momentum / early-build-fast / model ≥65 / model <65 /
  re-entry) × (regime ∈ up / down / range / null): cards, resolved, TGT1, SL, win%, net R.
- Also per (regime × direction CE/PE).
- Output: `server/data/regime-wins-report.json` + console table.
- Purpose: tells us which signal×regime combos to allow or gate — feeds future entry-gate
  tuning. Read-only; never writes observations.json.

## S2 — SL-width backtest (read-only script) — 3 pts

`scripts/slWidthBacktest.mjs <fromDate> <toDate>` — replays every resolved + open card's
contract premium timeline from captured minutes and simulates alternative stop policies.

Timeline rules (copy the journal exactly):
- Minute files `server/data/dhan/<date>/<HHMM>.json`; raw minutes first, archive gz
  (`archives/dhan/<date>.json.gz`, `payload.minutes[HHMM]`) as fallback — stream snapshots,
  never hold the whole archive.
- Contract row selection = journal `rowFor` rule verbatim:
  `card.expiry === series.next.e ? series.next.r : series.r`, row = strike + side.
- Walk minutes in timestamp order from `card.at`; the FIRST touch decides —
  never use session extremes to classify (that was the 2026-11-20 measurement bug).

Variants simulated per card:
1. Baseline: the stored SL (risk = entry − sl).
2. Wider stops: stop at entry − k × risk for k = 0.75 / 1.25 / 1.5 (risk renormalized).
3. Breakeven trail: once premium ≥ entry + 0.5×risk (or +1×risk), stop moves to entry.
   IMPORTANT: arm only on a crossing BEFORE the stop would hit — walk in order.
4. Close-time exit: if neither level hits by the last captured minute, mark
   `close-exit` with R = (close − entry) / risk.

Report per variant per bucket: SL rate, TGT1 rate, close-exit count, net R,
winners-lost (TGT1 winners that the variant would have killed), plus per-card
pre-target dip depth (how far below entry the premium dipped before reaching TGT1).

Output: `server/data/sl-width-report.json` + console table. Read-only.

**Gate:** the owner picks the shipped SL policy from this table. S4 (below) does not
ship until this report exists.

## S3 — PCR context on cards (small, live) — 1 pt

The PCR-shift gate is already live (955a416). Add the entry-time PCR context to
each card so the reader sees WHY the gate passed or skipped:

- At card build, compute `pcrAtEntry` (near-chain Σ PE OI / Σ CE OI) and
  `pcrShift` (15-minute % change) — reuse the Story-A history accessor or compute
  from the current + stored session series.
- Card fields: `pcrAtEntry: number|null`, `pcrShift: number|null`.
- Display: one line in the levels block — `PCR 0.87 (−4% 15m)` — on the app card,
  owner caption, subscriber caption and SVG. Same number on all copies.

Tests: build-path unit test with an injected PCR accessor (flat / rising / falling
→ stored values); null-safe when no data.

## S4 — underlying-anchored SL — 3 pts — GATED BY S2 REPORT

The premium stop fights theta (weekly 9%/day decay). The structural fix: the stop
is the **underlying invalidation level**, with the premium stop demoted to a
disaster backstop.

- `adaptiveLevels` already computes `needs.sl.level` (the spot level that
  reprices the premium to the stop). Promote it: every card gains a top-level
  `slSpot: number|null` field (= needs.sl.level when finite).
- Card + captions + SVG: the primary stop line becomes
  `🛑 Stop: SYMBOL ≤/≥ slSpot (invalidation) · premium hard-stop ₹sl (−X%)`.
- `server/journal.mjs`: SL resolves when EITHER trigger fires first —
  (a) the underlying (futures close from captured minutes) breaches `slSpot`
  in the bias direction, or (b) the contract premium breaches `card.sl`
  (existing rule). Record the additive field `outcome.slTrigger:
  'underlying' | 'premium'`; keep `status`/`r` semantics unchanged.
- Keep a disaster premium backstop at −70% of entry so a runaway contract can
  never ride to zero.

**Measurement gate (same as the wall-target lesson):** before S4 ships, re-grade
the 92 stored cards with the underlying-anchored rule using captured futures
minutes (futures per-symbol files exist for both sessions) and compare: SL rate,
net R, winners kept — vs the premium-anchored baseline. Ship only if SL rate
drops materially without eating the TGT1 winners. Quote the numbers to the
owner first.

Tests: journal test with a futures-candles fixture — underlying breach fires
`slTrigger: 'underlying'`; premium breach fires `'premium'`; neither stays open;
both in the same minute = ambiguous (existing rule).

## S5 — sector cluster cap — 2 pts

12 SLs landed on one correlated day — concurrent cards in one theme share a
single index move.

- Reuse the sector map already in `server/orbModel.mjs` (sector-leadership gate).
- At card build (earlyCards + advisor accept loop): count the session's still-open
  cards in the same sector (stored cards + current batch). If the count is at
  `SECTOR_CARD_CAP` (default 2, env), skip the new candidate with reason
  `sector cluster full: <sector>`.
- Skip log uses the standard advisor skip shape.

Tests: sector-map fixture, cap enforcement at the boundary, env override,
different-sector cards unaffected.

## Boundaries

- No changes to the live gates (trend/premium/open-chop/PCR/regime), the journal's
  win/loss semantics, or the wall-target parked code.
- Measurement scripts (S1, S2) are read-only — never write observations.json.
- Additive card fields only (`pcrAtEntry`, `pcrShift`, `slSpot`, `slTrigger`);
  nothing existing is removed or re-shaped.
- Every story ships with its own tests — Kilo writes and runs them (owner wants
  the testing muscle exercised this round).
- Deploy: pre-open (before 09:10 IST) or post-15:50 IST restart only; never
  mid-session.

## Story order

1. **S1 + S3 + S5** — independent, low-risk, ship first.
2. **S2** — measurement, report to the owner.
3. **S4** — only after the owner sees the S2 numbers and approves the SL-policy
   change (it moves the stop semantics he trades by).
