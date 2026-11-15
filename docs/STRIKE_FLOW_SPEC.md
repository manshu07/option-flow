# Strike Momentum Flow (Options Board) — V1 spec

**Status:** ST1 (server) DONE + live-verified 2026-11-15. ST2/ST3 = frontend, ready to build.
**Reference:** user's screenshot — one underlying's option contracts flowing on the S-curve
by premium change (NIFTY strikes, ±75% compressed scale, strike cards with premium zone +
S/R, "Spot only" honesty, underlying reference line).

**Rulebook (binding):** reuse existing components/models; additive only — the Order Flow
page and every existing behavior stay untouched; Vitest only (no E2E/Playwright); no new deps.

---

## ST1 — DONE: `GET /api/strikes/<SYMBOL>?date=YYYY-MM-DD&asOf=HHMM`

Server reads stored minute snapshots (live dir) or ONE archive session read for closed
days (`archive.readSession`, added). Response (~300 KB, cached 60s client-side is fine):

```jsonc
{
  "symbol": "NIFTY", "date": "2026-11-13", "expiry": "2026-11-17", "minuteCount": 123,
  "spot": [[epochMs, spot]],                       // ascending
  "strikes": {
    "25150|CE": {
      "strike": 25150, "side": "CE", "expiry": "2026-11-17",
      "prevClose": 252.9, "prevOi": 560885,         // previous session (null when none)
      "ltp": 137.75, "oi": 3579290, "volume": 123456, // as of the last (or as-of) minute
      "spotDistancePct": 0.02,
      "series": [[epochMs, ltp, oi, volume]]         // ascending, minute snapshots
    }
  }
}
```

- Strikes kept: within 5% of the last spot, nearest-ATM first, cap 64.
- `asOf=HHMM` truncates every series AND recomputes ltp/oi/volume from what survived —
  the payload never quotes a moment it does not show (replay/no-lookahead safe).
- Errors: 400 bad symbol/asOf · 404 no stored minutes · 503 archive read failure.
- Cache: server-side per `date|symbol`, invalidated when the minute count moves (live day).

Live-verified on real 2026-11-13 archive: 123 min, last spot 25144.30 (exact Friday close),
ATM 25150 CE/PE, 25150|CE OI 560k → 7.98M @14:00 → 3.58M @close (the evening CE unwind).

---

## ST2 — Strike flow model + page (frontend)

**New files (all under `src/features/strike-flow/`):**

- `feed.ts` — `fetchStrikeFlow(symbol, { date?, asOf?, signal })` → typed payload; accept
  404/503 as "no data yet" (not crashes).
- `strikeFlowModel.ts` + `strikeFlowModel.test.ts` — the calculations:
  - `strikeReadings(flow, window: 'day' | '1h' | '15m' | '5m')` → per contract:
    premium change % (Day: vs `prevClose`; intraday: series lookback by minutes with the
    SAME tolerance idea as `readFuturesWindow` in options-scanner/futuresModel.ts —
    a 7-minute gap is not "5m"), OI change + OI change % (same base rules), build-up via
    `classify()` from `@/lib/buildUp` with the `BUILD_UP_TIMEFRAME` floors, plus ltp/oi/volume.
  - Ranking: by |premium change %| descending; bullish side = premium up, bearish = down;
    NEUTRAL prints "No clear pattern" (reuse `scannerWords` wording).
  - Round-trip honesty: a contract with no baseline reading (untraded at the window start)
    shows no % (null), never a fake number.
- `StrikeFlowPage.tsx` — page shell:
  - Header: symbol chips (NIFTY / BANKNIFTY / SENSEX / F&O stocks — list from the existing
    underlyings loader) + window selector (reuse the window-chip/select patterns from
    ReplayControls/MarketFlowPage) + status line in FlowStatus's wording
    ("X up · Y flat · Z down of N · As of … · spot to HHMM").
  - Diagram: reuse `sCurve` / `compressedScale` / `FlowDiagram` layout primitives. Tiles =
    mid-rank strikes; up to 4–6 large cards = each side's top movers. The spot series is the
    dashed reference line labelled `<SYM> +x.xx%` (the screenshot's "NIFTY −17.97%" line).
  - Side filter pills: All / CE / PE (model already carries `side`).
- `App.tsx` — minimal tab chrome: `[Order Flow | Strike Flow]`, Order Flow default.
  Additive only; `MarketFlowPage` untouched.

**Data flow:** live mode = today's date (endpoint serves minutes as they are captured, cache
invalidates automatically); replay stretch goal (optional, do last): pass the replay cursor
as `asOf` + the replay date — the endpoint is already no-lookahead by construction.

## ST3 — Strike cards + popup

- Large card (reuse DiagramCard's shape): strike label ("NIFTY 25150C"), build-up badge
  (reuse `BuildMark`/`buildUpText`), conviction ring (reuse `Ring`), premium change %,
  premium ₹ + change, OI + OI change, mini chart from the contract's own series with the
  TF picker reuse (`candlesFromCloses` — session-anchored, already shipped).
- S/R for the card: heavy PE wall below spot = SUPPORT, heavy CE wall above = RESISTANCE —
  computed from the SAME endpoint's strikes map (sum OI per strike across sides' opposite
  contracts; the board's own `heaviestLevels` idea, adapted to the strikes map). Spot itself
  is the zone anchor. Do NOT invent static numbers.
- Popup on pin/click: taller chart + the reading in words (reuse FlowPopup patterns).
- "Spot only" honesty: a strike with OI always null (no positions) gets the same muted
  treatment the board gives names without futures.

## Boundaries + constraints

- Touch ONLY: new `src/features/strike-flow/*` files, `App.tsx` (tab chrome). If a shared
  market-flow component must be exported to be reused, export it WITHOUT changing its
  behavior, and list every such export in the delivery notes. `market-flow/*` internals stay
  closed otherwise.
- Server is DONE — if a gap is found, STOP and report (server is the architect's lane).
- Gates per story: `npm test`, `npm run lint`, `npm run build`, then STOP for verification.
- No new dependencies. No E2E. Fixed dates + fake timers in tests (2026-11-13 is the
  captured fixture day).

## Acceptance

- Unit tests for `strikeReadings`: window math (day + intraday tolerances), build-up
  classification per timeframe floors, ranking, NEUTRAL floor, no-baseline null %.
- Manual check: Strike Flow on NIFTY with `date=2026-11-13` renders ranked strikes from the
  archive; Order Flow page + replay behave exactly as before (old must work).
