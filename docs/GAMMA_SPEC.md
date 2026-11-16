# Gamma engine — Option B (self-computed from captured data) — Spec

**Owner:** Kilo Code (implementer, AFTER the Telegram Phase 2 batch lands and is verified) · Architect/verifier: Qwen · Date: 2026-11-16
**Owner decision:** compute IV ourselves via Black-Scholes inversion from the
premiums we already capture ("Go with Option B"); Dhan's captured IV (row
index 8) is a cross-check when finite and sane, never a dependency. Gamma is
derived data — no new Dhan endpoints, no un-gated timers.

## Prototype findings (gaps to fill FIRST — S0)

A prototype on today's captured NIFTY EOD data proved the pipeline works but
exposed real traps that MUST be handled:

1. **Stale / below-intrinsic premiums.** Several strikes print an ltp below
   Black-Scholes intrinsic (e.g. ATM CE near expiry) — the tick is old, not
   the market. Inverting those hits the IV floor (1–3%) which EXPLODES gamma
   (Γ ∝ 1/σ) and produces absurd GEX. Rule: **skip any strike whose premium
   is below its no-arbitrage floor** (CE: `S − K·e^(−rT)`; PE: `K·e^(−rT) − S`,
   floored at 0), with a 2% tolerance buffer above the floor.
2. **IV bounds.** Inverted IV must land in **[5%, 150%]**; outside → strike
   excluded from the gamma profile (counted in a `skipped` field for the UI).
3. **Captured IV preference.** If row index 8 (iv) is finite and within
   [5%, 150%], USE it and mark `source: 'feed'`; else invert and mark
   `source: 'inverted'`. The UI/tests can then compare both populations.
4. **Zero/near-zero OI or premium < 0.5** → excluded (same rule as the
   advisor's no-lottery-strikes).
5. **OI units.** Rows carry OI in units (not lots) — GEX uses units as-is.
6. **Time to expiry.** `T = (expiry 15:30 IST − capture t)`, floored at one
   hour; computed per series from `series.e` and `series.t` — never
   wall-clock at view time.

## S1 — `src/features/market-flow/gammaModel.ts` (pure, testable)

- `ivFor(premium, S, K, T, r, side)` — Newton-Raphson inversion with the S0
  bounds; `r` from `GAMMA_RISK_FREE` env, default 0.065.
- `gammaProfile(series, { lot })` → `{ strikes: [{K, side, iv, ivSource,
  gamma, gex}], skipped: number, totalGex, flipLevel, regime }` where
  - `gex = gamma × oi(units) × S² × 0.01` with the pinned sign convention:
    **calls contribute positive, puts negative** (the standard
    dealers-short-puts flip; document it in the module header as an
    ASSUMPTION, not a fact).
  - `flipLevel` = strike where cumulative GEX (ascending strikes) changes
    sign; null when it never crosses.
  - `regime` = `'gamma-long' | 'gamma-short' | null` from spot vs flipLevel.
- Tests: below-intrinsic strike skipped; IV bounds enforced; captured-IV
  preference; gamma peaks near ATM for a sane synthetic chain; flipLevel
  sign change; **regression fixture from today's real captured NIFTY row
  values** (numbers recorded in the test file after the prototype run).

## S2 — Option Board gamma view (indices first: NIFTY, BANKNIFTY)

- Strike bars gain a **GEX overlay** (call GEX above the zero rule, put GEX
  below, heaviest 3 strikes labelled) and a **flip-level line** with the
  regime chip (`Gamma Long`/`Gamma Short`) next to the mode pills.
- Computed client-side from the same captured payload the board already
  renders (pure `gammaProfile` on the series rows) — no new endpoints.
- SENSEX: the chain is empty (known Dhan BSE gap) — the overlay silently
  hides when `strikes` is empty; add a code comment pointing at the memory.

## S3 — Gamma in the Observations pipeline (owner request)

- `runAdvisor` state gains gamma fields per candidate: `gexAtStrike` (that
  strike's GEX), `distanceToFlip` (spot − flipLevel, in %), `regime`.
- **Pin candidates:** when days-to-expiry ≤ 2 and the candidate strike is
  within 0.3% of the max-gamma strike, the card gains a `pin` note
  ("gamma pin zone — expect gravitation to this strike") — Jev gets this as
  state, not as an instruction.
- **Stop confirmation:** if the card's wall-based stop sits beyond the
  flip level, the card notes "stop beyond gamma flip — dealers may
  accelerate the move".
- Card display: one extra line in the Chain walls section: `Γ regime:
  short · flip 25180 · pin 25250CE`. Card message (v2 template) gains the
  same line.

## S4 — Gamma unwind watch (digest-folded)

Per build for the watched symbols + NIFTY/BANKNIFTY: any strike that held a
top-3 gamma concentration at first evaluation and has since shed ≥25% of
its OI (prevOi vs oi) emits one digest line
(`Γ unwind: 25250CE −31% OI (was heaviest call gamma)`). Baseline stored in
the digest state at first evaluation of the day (same pattern as S6 in the
Phase 2 spec).

## S5 — Full F&O stock rollout

After indices validated for a week (spot behaviour around flip and pin
levels compared visually), enable the overlay + advisor fields for all
stock underlyings — a config list `GAMMA_SYMBOLS` env (default
`NIFTY,BANKNIFTY`) that the user widens. No code change needed to widen.

## Parked

- Flip-cross instant Telegram alert (needs the validation week first).
- Gamma squeeze detection, expiry-day pin strategy views, per-strike gamma
  history charts.
- SENSEX gamma until Dhan's BSE chain flows.

## Gates per story

- `npm test` green, `npx tsc --noEmit` clean; no new network calls anywhere;
  stories land one commit each in order S0+S1 → S2 → S3 → S4 → S5.

## Handoff prompt (paste into Kilo AFTER the Phase 2 batch is verified)

> Read `docs/GAMMA_SPEC.md` and implement it in order: S0 gap-fill rules +
> S1 `gammaModel.ts` with its tests first, then S2 the Option Board overlay,
> S3 the observations/advisor gamma fields, S4 the unwind watch, S5 the
> config-driven rollout. One commit per story. All gamma math is pure
> client-side computation from already-captured chain rows — no new Dhan
> endpoints, no new timers, SENSEX silently skipped. Pause for verification
> after each story's tests pass, or at the end of S1 if running the batch.
