# DIRECTION_GATE_EARLY_WATCHER_SPEC

Owner-approved 2026-11-25 (post the 4-SL day review and the missed APLAPOLLO/APLAPOLLO-style
crash discussion). Two features, one shared backtest gate. CODE-ONLY — no Jev/LLM anywhere in
decisions. Sequenced AFTER MCX C1 is delivered and verified.

## Context facts the implementer must know

- The advisor regime gate now reads fut-stats recentCloses correctly (fix landed 2026-11-25,
  `regimeFor` fallback). Regime values are trustworthy from 2026-11-26.
- Today's 4 SL cards were bullish CE on names that lagged while NIFTY rose +1.85% — index-up
  does NOT imply stock-up. This is why the gate has 3 layers, not 1.
- Measured precedent: the RANGE-regime retro-fit (F1) turned 92 cards / −0.70R into 4 cards /
  +5.66R. Both features here must earn their place the same way: offline backtest BEFORE ship.
- Index spot is ~60s stale (Dhan WS gap). Use NIFTY/BANKNIFTY FUTURES (WS, live) as the
  primary direction input; spot is secondary.

## S1 — marketDirection.mjs (pure model, no I/O)

Input: NIFTY fut candles (15m resample), sector peers' fut closes, symbol's own fut candles.
Output: `{indexTrend: 'up'|'down'|'flat', sectorTrend: ..., stockTrend: ..., gate: 'pass'|'block-bull'|'block-bear'|'capitulation-exempt'}`.

- 15m trend = last two 15m closes vs VWAP(15m) — majority decides; flat when mixed.
- Sector trend = median of sector peers' same-period returns (sector map from the ORB
  scanner's existing sector module — reuse it, do not rebuild).
- Gate logic for a bullish card: block when stockTrend=down AND (indexTrend=down OR
  sectorTrend=down). Mirror for bearish. When ALL three disagree, flat (pass).
- **Capitulation exemption** (feeds Early Move Watcher): sharp adverse drop (≥2% from session
  high) + PE/CE wall build at the nearest strike + a completed 15m reversal candle ⇒
  `capitulation-exempt` — the gate passes the counter-trend card and TAGS it.
- Index spot never used for the trend decision.

## S2 — wire the gate into strikeAdvisor

- `runAdvisor` calls marketDirection before pricing any candidate; blocked candidates are
  dropped with log line `advisor direction gate: <SYM> blocked (index down / sector down)`.
- Blocked candidates are STILL stored as stub cards `{blockedBy: 'direction-gate', no telegram,
  no subscriber send}` so the gate can self-score weekly (see S4).
- Env: `ADVISOR_DIRECTION_GATE` (default 1).

## S3 — Early Move Watcher (earlyMoveWatcher.mjs, pure + one wire-in)

- Trigger: |move| ≥ 0.7% in the 09:45–11:00 IST window, BOTH sides.
- Confirmation 2-of-3, computed in parallel at trigger time:
  1. nearest-strike PE (bull) / CE (bear) OI build vs prev (guard: skip OI confirmation when
     the leg's prevOi is a disk-seed placeholder — the Dhan next-month previous_oi=0 trap),
  2. VWAP reclaim (bull) / VWAP loss (bear) on the symbol's own futures,
  3. completed 15m reversal candle (closed beyond prior candle extreme).
- Output: `EARLY-GRAB` cards via the existing earlyCards path (labelled `early: 'grab'`),
  RR≥2 expectancy policy untouched, ORB tag unchanged.
- Caps: max 3 EARLY-GRAB per day; same symbol two consecutive failed grabs = out for the day
  (persisted per-day state like levelHitsFired).
- DNA: read `server/data/hundred-ways-<SYM>.json` best-stack only to ATTACH a tag line
  `DNA: <stack> (n=<k>)` — never gates, never boosts, never sizes.

## S4 — self-scoring backtest gate (SHIPS OR KILLS BOTH)

- `scripts/directionGateBacktest.mjs <from> <to>` — replays Nov 18–25 captured minutes
  offline (archive-gz allowed), scores: baseline net R vs gate-on net R, blocked-stub
  what-if outcomes, EARLY-GRAB hypothetical outcomes, per-day card/SL counts.
- **Ship gate:** direction gate must improve net R without losing >1 existing TGT1 winner;
  EARLY-GRAB must be net-positive on the same window. FAILED gate = feature stays off
  (`ADVISOR_DIRECTION_GATE=0`, watcher not wired) and the report says so — like
  WALL_TARGETS S0.
- Weekly self-score: `journalStats` gains a direction-gate section comparing blocked stubs'
  what-if outcomes vs sent cards (S4 output reused weekly).

## File map (read-first; touching anything else = stop and ask)

| File | Sections | Story |
|---|---|---|
| server/strikeAdvisor.mjs | regimeFor (fallback, do not break), earlyCards, runAdvisor candidate loop, acceptCheck | S2, S3 |
| server/moveRegime.mjs | liveRegime, REGIME_LOOKBACK | S1 |
| server/orbModel.mjs / sector map module | sector classification (reuse) | S1 |
| server/fut-stats store reader (scripts/futStats or its builder) | recentCloses shape | S1 |
| server/hundred-ways-<SYM>.json + SUMMARY | best-stack shape (read-only) | S3 |
| server/alerts.mjs | marketMovers, per-day state patterns | S3 |
| server/observations.json store shape | stub-card addition | S2, S4 |
| scripts/retrySparseBackfill.mjs | date-walking pattern for the backtest script | S4 |
| docs/WALL_TARGETS_SPEC.md | S0 backtest-gate discipline (methodology reference) | S4 |

## Gates per story

vitest suite green with exact count + new tests per behaviour + `npx tsc --noEmit` +
`npm run build` clean + one commit per story (`feat(gate): S1` …). Architect verifies each
pause; restart only post-close (architect owns it).
