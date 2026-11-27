# MCX_OPTIONS_C6_SPEC — MCX option chains → observation cards

Owner-approved 2026-11-27 ("Plan in detailed a top level architecture do and then start
implemented. first write then start work"). Builds on MCX C1-C5 (futures live, cards live,
journal + close5 SL live). Feed-load measured GO: core 681/4688 per conn — GOLD/SILVER/
NATURALGAS ATM±10 monthly ≈ 44 legs (+1%).

## Top-level architecture (data flow)

```
Dhan WS conns 1-3 (option legs, cap-guarded)
  └─ NEW: MCX option legs — GOLD/SILVER/NATURALGAS monthly OPTFUT, ATM±10
     (segment byte: MCX_COMM, same as futures; master instrument OPTFUT)
       └─ provider holds them → ticks for strike rows (ltp/oi/prevOi)
            └─ build() → encodeMcxSeries(MCX symbol, futSpot, prevClose, strikes[], expiry)
               → market file series entry: { s, sp, pc, e, r:[strike rows], exchange:'MCX' }
                    └─ strikeAdvisor: mcxCards upgrades — for GOLD/SILVER (liquid):
                       premium-based OPTION cards via candidateStrikes(spread gate)
                       + adaptiveLevels on MCX-FUT percentile stats
                       (NATURALGAS + minis stay futures-direct — thin options)
                        └─ journal: resolveCard unchanged — MCX option cards have
                           finite strike/side, rows exist in series.r (same 18-col
                           layout), validCard passes
                            └─ checkLevelHits + SL_EVAL=close5: work unchanged
                               (optionKey path via provider.ticksFor)
```

Design rules:
1. **Reuse everything** — encodeSeries, candidateStrikes, chooseChain spread gate,
   adaptiveLevels, journal resolveCard, level-hits: all operate on the same series
   shape. MCX is just another series with `exchange: 'MCX'`.
2. **Liquid-only options** — GOLD/SILVER get option cards; NATURALGAS + minis keep
   futures-direct cards (their options are too thin for the spread gate).
3. **One expiry** — near monthly only (MCX monthly = 3rd-last working day). No weekly.
4. **Cap-guard mandatory** — option legs go through the same plan builder; if the
   plan overflows, MCX options trim FIRST (NSE/BSE never lose legs to MCX).
5. **prevOi honesty** — MCX option prevOi seeds from the previous session's close only
   (same as NSE next-month trap: Dhan gives previous_oi = 0 for new contracts).

## Stories

### S1 — master resolution + subscription
- Resolve MCX monthly OPTFUT rows from `data/.dhan-master.csv` for GOLD/SILVER/
  NATURALGAS: near expiry, ATM±10 around the current futures close.
- Extend the provider plan builder: MCX option legs join the near window with
  segment MCX_COMM; cap-guard trims MCX options first if overflow.
- Log line at boot: `feed want … (+MCX options N)`.

### S2 — capture
- Provider holds MCX option rows → build() encodes them into the MCX series
  `strikes` array (same encodeSeries path as NSE).
- prev-day OI seed for MCX options from the previous session's close (seedPlan
  extension; new-contract rows with no baseline stay `baseline missing`).

### S3 — advisor cards
- `mcxCards` upgrade: when the symbol's option chain has ≥2 liquid candidates
  (spread ≤2% of mid, OI ≥10k, volume ≥1k), build a premium OPTION card
  (strike from chain logic, entry/SL/TGT1/TGT2 via adaptiveLevels on the MCX-FUT
  move stats, bias from OI+price momentum as today).
- NATURALGAS/minis (no liquid candidates) keep the futures-direct card.
- Cards are labelled `exchange: 'MCX'` with a normal finite strike → journal,
  level-hits and close5 SL work unchanged.

### S4 — verification
- Live probe in tonight's MCX session: series rows count, chain rows, first
  option card (may be none — gates decide), journal resolve on an MCX option card.
- Full suite + tsc + build; restart post-close (architect-owned).

## Read-first file list (Kilo: read END-TO-END before code; anything outside the
list = stop and ask)

| File | Sections | Stories |
|---|---|---|
| server/providers/dhan.mjs | SEG_BYTE map, buildWindows/plan builder + cap-guard, nearMonthFuturesId, encodeSeries | S1, S2 |
| server/prevDaySeed.mjs | seedPlan (expiry-aware prevOi) | S2 |
| server/index.mjs | build(), mcx series encoding, mcxCards wiring, checkLevelHits | S2, S3 |
| server/strikeAdvisor.mjs | mcxCards, candidateStrikes, chooseChain spread gate, adaptiveLevels, acceptCheck | S3 |
| server/journal.mjs | resolveCard, rowFor, validCard | S3 (verify only) |
| server/mcx.mjs | live quote source (unchanged) | — |
| data/.dhan-master.csv | MCX OPTFUT rows (instrument col 4 = OPTFUT, expiry col 9) | S1 |
| docs/MCX_FULL_SPEC.md | C6 section (gating context) | all |

## Gates per story
vitest full suite green + new tests per behaviour + `npx tsc --noEmit` +
`npm run build` clean + one commit per story (`feat(mcx-c6): S1` …). Restart is
architect-owned (post-close only).
