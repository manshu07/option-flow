# WALL TARGETS SPEC — structure-anchored card targets (walls + history + decay)

Status: APPROVED design 2026-11-20 (owner discussion "why do we set targets that are impossible to reach… we have gamma data"). Implementation via Kilo. r1.

## Problem statement

Card targets today are percentile guesses of the underlying's favourable move
(TGT1 ≈ p30, TGT2 ≈ p85 of moveStats), converted to premium net of decay.
Measured 2026-11-20 over 76 cards: TGT2 hit ~1-4%, SL 65%, win-rate 26%.
The percentile target ignores market structure: **option premiums gravitate to
and accelerate at OI/gamma walls** — and that data already sits on every card
(`card.support`, `card.resistance`, `card.gamma` flip/pin/regime) but is never
used to pick targets.

Goal: targets anchored to real market structure (walls), verified against the
same historical move distribution, still paying ≥1:2 net of decay. A target
that no wall provides inside the reachable move, or that does not pay 1:2,
must not be quoted.

## Non-goals (v1)

- Do NOT change the stop. SL stays the existing adaptive stop
  (history/ATR-based premium stop). Underlying-anchored stops are a later spec.
- Do NOT change the trend/premium/open-chop gates in `earlyCards`.
- Do NOT change journal semantics. The journal grades the premium levels on the
  card; it needs no change for this feature.
- Do NOT remove the existing percentile fallback. Walls are preferred;
  percentile targets remain the fallback when no usable wall exists.

## Stories

### S0 — measurement gate (script, must run first) — 2 pts

`scripts/wallTargetBacktest.mjs <fromDate> <toDate>`.

For every stored card in the date range:
1. Rebuild the wall set **as of the card's build minute** from the card's own
   stored fields (`card.support`, `card.resistance`, `card.gamma.flipLevel`,
   `card.gamma.pin`) — do NOT use today's data.
2. Compute the candidate wall-target premium the new logic would have quoted:
   the best wall spot-level within the p50 favourable move for the card's hold
   window (moveStats), repriced via `premiumAtLevel` (optionMath) net of decay
   at the card's expiry, using the card's own entry premium and the capture
   timeline.
3. Walk the captured minute files (same timeline pattern as
   `scripts/slc-measure.mjs` / journal `rowFor`: pick the chain by
   `card.expiry` vs `series.next.e`, row = strike + side) and record, per card:
   - old outcome (TGT1 / SL / open) with the existing premium levels,
   - wall-target outcome with the new premium levels (same minute-close
     semantics, SL unchanged),
   - pre-target dip, gap behaviour, minutes to hit.
4. Print a report:
   - wall-target hit rate vs percentile-target hit rate (per signal bucket
     early·momentum / early·build-fast / model ≥65%, and per day),
   - net R difference (wall target R uses the same risk normalization),
   - how many cards would have become `no-trade` (no wall target paying 1:2).

**Gate:** S2 ships only if, on this measured sample, wall targets beat the
percentile targets on net R at equal-or-better SL rate, per bucket. If they do
not, STOP and report the numbers to the owner — do not ship a losing target
policy. (Owner rule: real measured data first.)

Output file: `server/data/wall-target-report.json` + a console table.
S0 is read-only. Do not write to observations.json.

### S1 — pure wall-target module — 3 pts

`server/wallTargets.mjs` (pure, no I/O, unit-tested):

```js
export function wallTargets({ spot, entry, sl, expiryDate, holdDays, decayPerDay,
  moveStats, walls, gamma, contract }) → {
    basis: 'walls+decay' | 'insufficient',
    tgt1: premium, tgt1Spot: level, tgt1Wall: { strike, oi, kind },
    tgt2: premium|null, tgt2Spot: level|null, tgt2Wall|null,
    reach: { tgt1: fraction, tgt2: fraction|null },
    rr: number, reject: null | { reason },
  }
```

Selection rules (in order):
1. Collect candidate spot levels: every distinct OI wall strike from
   `walls.support` / `walls.resistance` structures on the bias side
   (bullish → CE walls above spot; bearish → PE walls below spot), plus
   `gamma.pin` and levels implied by `gamma.flipLevel` only when
   `gamma.regime === 'gamma-short'` (below flip, moves accelerate).
2. Drop levels beyond the p85 favourable move for `holdDays`
   (moveStats percentiles; use the recent-era percentile set the existing
   ingest stores). Drop levels on the wrong side of spot.
3. Reprice each remaining level to a premium with `premiumAtLevel`
   (optionMath, same decay basis as adaptiveLevels: contract expiry, theta to
   `expiryDate`, decayPerDay context).
4. Score each candidate: `rr = (premium − entry) / (entry − sl)`;
   require `rr >= 2` (ADVISOR_MIN_RR) and `premium > entry`
   (positive after decay). Prefer the candidate with the highest wall OI that
   passes; tie-break by smaller distance from spot.
5. TGT2: the next wall beyond TGT1 that pays `rr >= 3` (bonus tail), same
   filters; null if none.
6. If nothing passes → `basis: 'insufficient'`, `reject.reason` explains which
   gate failed (no wall in reach / R:R thin / decay ate it).

Env: `ADVISOR_MIN_RR` reused (same default 2). No new env vars in S1.

Unit tests (server/wallTargets.test.ts): reach filtering, wrong-side walls,
OI preference, rr gate, decay-to-zero premium, TGT2 selection, cap on levels
beyond p85, gamma-short flip usage, gamma-long ignores flip-as-target.

### S2 — advisor integration — 3 pts

`server/strikeAdvisor.mjs`:

- Compute the wall set at card build (already available: `chainWalls(series)`
  for OI walls; `gammaCandidateData` already carries gamma fields — extend it
  to also expose `flipLevel`, `pin`, `regime` at the chosen strike context if
  not already present).
- Call `wallTargets(...)` with the card's context. Gate behind
  `ADVISOR_WALL_TARGETS` (default `1`): `0` restores today's behaviour
  entirely.
- If `basis === 'walls+decay'`: quote its premium as TGT1/TGT2
  (levelsBasis: `'walls+decay'`), keep the existing adaptive SL, and set
  `card.tgt1Wall = { strike, oi }`, `card.tgt1Reach = reach.tgt1`.
- If `basis === 'insufficient'`: log the reject reason
  (`advisor wall-target: SYMBOL reject — <reason>`), then fall back to the
  existing percentile/ATR path (unchanged code), but apply the owner's
  no-trade rule: if the fallback ALSO fails `rr >= ADVISOR_MIN_RR`, the card
  is skipped exactly like today's negative-expectancy skip (same skip list
  shape: `{ symbol, reason }`).
- `levelsFor` / `snapTick` (₹0.05 grid) still apply to the final quoted
  premium — wall-repriced premiums snap too.
- Keep `levelsBasis` contract: allowed values grow by one
  (`'walls+decay'`); the UI already prints the string as-is.
- The re-entry card path (rebuild after SL recovery) uses the same wall
  targets — it calls the same enrich pipeline.

Update `docs/CARD_V3_SPEC.md` Card fields: `tgt1Wall`, `tgt1Reach`,
`levelsBasis` new value.

### S3 — rendering — 2 pts

`src/features/observations/ObservationsPage.tsx` + `server/observationCardSvg.mjs`:

- Owner caption + SVG: TGT1 line gains its context —
  `🎯 TGT1 <b>premium</b> (wall 83000 CE · OI 7.4L · hit 62% past windows)`.
- Subscriber caption: same numbers, stripped copy rules unchanged (no
  model/quality words; wall/OI/reach are educational facts, keep them).
- App card: a small line in the levels block —
  `TGT1 wall: 83000 CE (7.4L) · reach 62%` — only when
  `levelsBasis === 'walls+decay'`.
- Zone tint logic untouched (it reads premium vs sl/tgt1/tgt2 — the wall
  premium flows through the same fields).

### S4 — journal/reprice consistency — 1 pt

- `server/journal.mjs`: no logic change (it grades premium levels).
- `scripts/repriceCards.mjs`: confirm re-pricing routes through the same
  `adaptiveLevels` (wall path automatic). Add a `--report` line per card:
  `basis=walls+decay wall=83000CE` when present.

### S5 — gates, rollout, verification — 1 pt

- Full gates: `npm test`, `npx tsc --noEmit`, `npm run build`,
  `git diff --check`.
- S0 report numbers quoted in the PR/commit message.
- Deploy: pre-open (before 09:10 IST) or post-15:50 IST restart only.
- Post-deploy verification: first wall-quoted card compared against Dhan
  quote for its strike; `levelsBasis` distribution for the day logged.

## Data sources already available (do not create new ones)

- `chainWalls(series)` — OI support/resistance walls (strikeAdvisor).
- `card.gamma` — flipLevel, regime, pin, gexAtStrike (gammaProfile).
- `loadMoveStats(symbol)` — favourable/adverse percentiles for hold days
  (p30/p50/p70/p85/p95), recent era.
- `premiumAtLevel`, `spotForPremium` — optionMath (decay-aware repricing).
- `server/data/dhan/<date>/<HHMM>.json` minute files — S0 timeline source;
  contract row selection MUST use the journal rule (`series.next.r` when
  `card.expiry === series.next.e`, else `series.r`).

## Boundaries

- Never quote a negative or below-entry premium target.
- Never quote a target without its required spot level + reach %.
- A card whose only wall target fails 1:2 falls back to the percentile path
  and, if that too fails, is skipped with its reason — visible in the skip log.
- Keep `decay-too-heavy` behaviour unchanged.
- All existing tests must keep passing; new logic ships with its own tests.
- Server changes deploy pre-open (before 09:10 IST) or post-15:50 IST only.
- S0 report numbers must be quoted to the owner before S2 rollout.

## Acceptance

1. S0 report exists with measured per-bucket hit rates and net R.
2. S2 gated by the S0 result and `ADVISOR_WALL_TARGETS`.
3. Wall-quoted card verified live against Dhan (strike premium within tick).
4. Full suite green, tsc + build clean, restart post-close.
