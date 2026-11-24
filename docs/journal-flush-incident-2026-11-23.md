# Futures Flush Incident: 2026-11-23

## Executive Finding

The current repeated `futures tick flush failed: batch collection: Invalid time value` has a concrete collector bug. The live feed stores a candle in `futTicks` under its minute timestamp, but the candle object does not need an `at` field: `noteTick()` computes the minute and updates the Map entry (`server/providers/dhan.mjs:569-590`). `collectTickJournalBatch()` previously iterated only the Map values and passed `candle.at` to `ymdIst()` (`server/providers/dhan.mjs:191-226`). `ymdIst()` calls `new Date(...).toISOString()` (`server/providers/dhan.mjs:96`), so a feed-created candle with `candle.at === undefined` throws `RangeError: Invalid time value`.

The collector now takes the timestamp from the Map key, validates it before date conversion, and skips invalid/out-of-range keys. The complete flush callback is step-labelled and inside a try/catch (`server/providers/dhan.mjs:407-431`). The 60-second supervisor contains thrown callback errors and logs once per failure streak (`server/providers/dhan.mjs:245-320`). A regression test reproduces the exact feed shape: numeric Map key with a candle body lacking `at`, plus invalid and out-of-range keys.

## 2026-11-23 Evidence

The report was run with:

```text
node scripts/futuresFlushReport.mjs 2026-11-23
```

It found 228 persisted futures JSON files, 40,365 valid tick-journal rows, no malformed journal rows, and no per-symbol candle-time gap over five minutes in the available full-session journal. For 08:08–08:12Z, it counted 525 journal rows across 105 symbols; TITAN has five rows in that window. These are candle `at` records, not counts of flush callbacks. A single flush can append a batch of rows.

The launchd log contains four archive failures:

- `server/data/logs/order-flow.launchd.out.log:23656` — `2026-11-23T08:08:07.880Z archive failed: ARCHIVE_FAILED Invalid string length`.
- `server/data/logs/order-flow.launchd.out.log:23665` — `2026-11-23T08:09:39.754Z archive failed: ARCHIVE_FAILED Invalid string length`.
- `server/data/logs/order-flow.launchd.out.log:23684` — `2026-11-23T08:11:47.237Z archive failed: ARCHIVE_FAILED Invalid string length`.
- `server/data/logs/order-flow.launchd.out.log:23690` — `2026-11-23T08:12:25.297Z archive failed: ARCHIVE_FAILED Invalid string length`.

The same log shows continued persistence after those failures: lines `23661-23662` report full-chain and market-file writes at 08:08:29Z; lines `23668-23672` report writes at 08:10:40Z and 08:11:03Z; lines `23691-23692` report writes at 08:12:35Z. The report found **zero** `futures tick flush failed` lines in the incident window.

## Causality And Limits

The `Invalid time value` collector bug explains the current tick-flush error when feed-created Map values lack `at`. It does not establish that the archive `Invalid string length` errors caused that failure, or that the futures pipeline died at 13:39 IST. The incident-window artifacts instead show journal rows throughout 08:08–08:12Z and later successful market writes. The evidence supports temporal correlation between archive failures and the window, not a causal link.

The per-session futures JSON is overwritten; its file `mtime` is only the latest modification and may be later than the incident. Tick-journal `at` fields are candle timestamps, not wall-clock append times. Historic flush counters were not recorded, so exact per-callback flush times and the first physical write time for each overwritten JSON file cannot be reconstructed. New health counters are exposed by `provider.health().futuresFlush` (`server/providers/dhan.mjs:1932-1943`) and `/api/health` at `feed.futuresFlush` (`server/index.mjs:604-621`); they will be available to the running process after the architect's single restart. No restart was performed for this batch.
