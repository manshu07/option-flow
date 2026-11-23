# CAPTURE_RESILIENCE_SPEC — restart-proof capture + honest gap-aware charts (Kilo Batch-4)

Owner-approved 2026-11-23 (everything except the time-spaced x-axis option, explicitly rejected).
Root cause this batch fixes: 2026-11-23 lost large capture chunks (WS full drop + 429 storms +
two mid-session restarts) and the day's charts rendered from ~22 gappy candles. Futures candles
CAN be backfilled from Dhan's charts REST; option-chain minutes cannot — that loss is permanent.

Standing rules that apply: reuse-first (the merge from `90d017b` and `futRest` one-shot backfill
already exist — extend them, never fork), old must keep working, server restart stays with the
architect (implementer only builds + tests).

## S1 — Boot-time TODAY gap backfill (server/providers/dhan.mjs, server/index.mjs)

After the provider's existing prev-day REST backfill pass completes at boot, run ONE paced pass
for the CURRENT session: for each instrument whose in-memory futures candles are sparse
(< 30 bars for the elapsed session) AND whose last in-memory candle is older than ~2 minutes,
fetch today's `/charts/intraday` candles for its near-month contractId and field-level merge
(max high / min low / feed-authoritative close+oi) into `futTicks`, exactly like the `90d017b`
persisted-file merge. Pacing: reuse the existing charts pacing + 429 rest windows — this pass
runs AFTER the boot crawl, never parallel to it; skip contracts already cooling from a 429.

Accept: with a captured file present but a gapped day, `GET /api/futures/TITAN` after boot shows
the gaps filled from REST within ~3 minutes of boot, merge never loses a feed OHLC field, and a
429 mid-pass leaves the rest of the pass queued (no crash, no storm).

## S2 — Local tick journal (restart-proof futures capture) (server/providers/dhan.mjs, server/index.mjs)

Append-only journal so a restart can rebuild today's futures ticks WITHOUT any Dhan call:
- Every minute-flush of `futTicks` also appends one compact NDJSON line per contract that
  changed: `{"at":<ms>,"sym":"<SYMBOL>","o":..,"h":..,"l":..,"c":..,"oi":..,"v":..}` to
  `<MF_DATA_DIR>/<date>/futures-ticks.ndjson` (one buffered `appendFileSync` per flush batch —
  keep it to ONE write syscall per minute, small payload).
- At boot, BEFORE any REST backfill: if today's journal exists, replay it into `futTicks`
  (last-write-wins per at+sym, same field-level semantics).
- Rotation is inherited from the per-day capture dir (a new session starts a new file).
- Size sanity: one day ≈ 228 symbols × ~385 minutes × ~110 bytes ≈ 9 MB uncompressed. Acceptable.

Accept: kill -9 the API mid-session, restart, and `/api/futures/<SYM>` returns every minute that
was live before the kill, with zero new Dhan REST calls made for those minutes. Unit-test the
replay (write fixture journal → boot path → candles) and the single-write-per-flush behaviour.

## S3 — Post-close today-backfill (server/index.mjs)

The daily history-refresh block (after 19:30 IST, `bb1db3e` chain) gains one more child step:
backfill TODAY's futures gaps from `/charts/intraday` for every symbol whose today-file has
< 60% of the session's expected minutes, paced by the existing charts pacing. Merge into
`server/data/dhan/<date>/futures/<SYMBOL>.json` with the same field-level rules; official rows
and feed rows keep winning over REST. Log: `history refresh done: … today-backfill=<n symbols>`.
Never runs during market hours (reuse the same isMarketSessionTime guard the other steps use).

## S4 — Gap-aware chart rendering (client only, src/features/market-flow + observationModel)

Honest display for sparse days (do NOT fabricate candles):
- When a chart's window has gaps > 5 minutes between adjacent candles, render the gap as a
  visually distinct hatched/empty band (a subtle grey band, no fake candles) and show one plain
  line under the chart: "Capture gaps: 3 (09:10–09:28, 09:30–10:25, …)" — max 3 ranges listed,
  then "…".
- Keep every existing drawn feature (S1/S2/R1/R2 lines, zone box, prev-close dashed line,
  last-price dot, ticks, tf selector) — per the mini-chart rule, nothing is removed.
- Timeframe switching must still re-bucket (existing behaviour); with < 30 bars available the
  existing extend-to-session rule applies, and the gap note tells the owner why the chart is thin.
Accept: on a sparse fixture (22 candles with 3 gaps) the chart renders candles + gap bands + the
note; on a full-day fixture the note says "Capture gaps: none".

## S5 — 429 pacing tuning (config-level, server/providers/dhan.mjs)

Make the boot/open crawl gentler so 429 storms don't cascade into WS instability:
- During the first 10 minutes after an in-session boot, interleave a small sleep between
  option-chain crawls (env `BOOT_CRAWL_PACE_MS`, default 250ms) and keep the existing rest
  windows untouched.
- After that window, behaviour is exactly as today (old must keep working).

## Out of scope (explicitly)

- Time-spaced x-axis (owner rejected).
- Option-chain minute recovery (impossible — Dhan has no historical chain API; do not attempt).
- Any change to `server/journal.mjs`, `.fast/`, `scripts/h6rs*` (architect-owned).

## Gates

Per story: full `npx vitest run` green + `npx tsc --noEmit` clean + `npm run build`, one commit
`feat(capture): SN`. Do NOT restart the service — the architect batches one restart post-close.
Report the restart requirement in the pause summary instead.
