# MCX Phase 0 Spike Findings

**Status:** offline/cache findings complete; live-feed, REST candle, and official MCX holiday verification blocked. This is a read-only spike. No provider, market-session, or underlying production file was changed, and the service was not restarted.

## Contract Master

Source: `data/.dhan-master.csv`, the cached Dhan scrip master fetched from `https://images.dhan.co/api-data/api-scrip-master.csv`. The cache was 30,011,884 bytes, modified `2026-11-23T18:40:18.143Z`, SHA-256 `df09ea6cdb213d3743fcbbf85686f8746e46524550ec2ef22f66d52a583e5b11`. The selection uses MCX segment `M`, futures `FUTCOM`, options `OPTFUT`, and the earliest FUTCOM expiry on or after `2026-11-24`.

| Requested root | Master symbol | Near FUTCOM securityId | Expiry | SEM_LOT_UNITS | SEM_TICK_SIZE | Active option expiries | Active strike/expiry pairs |
|---|---|---:|---|---:|---:|---:|---:|
| GOLD | GOLD | 495213 | 2026-12-04 | 1 | 100 | 11 | 2,160 |
| SILVER | SILVER | 495214 | 2026-12-04 | 1 | 100 | 10 | 2,252 |
| NATURALGAS | NATURALGAS | 574319 | 2026-11-24 | 1 | 10 | 2 | 181 |
| GOLDM | GOLDM | 575011 | 2026-12-04 | 1 | 100 | 3 | 475 |
| SILVERM | SILVERM | 483080 | 2026-11-30 | 1 | 100 | 9 | 1,982 |
| NATURALGASM | NATGASMINI | 574320 | 2026-11-24 | 1 | 10 | 2 | 181 |

All six have `OPTFUT` rows in the cached master. `optionsByExpiry`, with per-expiry row, strike, CE, and PE counts, is in [`mcx-spike-contracts.json`](mcx-spike-contracts.json). Counts exclude option expiries before the as-of date. The gzip raw evidence contains 14,997 selected master rows, including expired option rows, plus the original CSV header: [`mcx-master-rows.csv.gz`](mcx-spike-evidence/mcx-master-rows.csv.gz).

The table preserves Dhan's raw `SEM_LOT_UNITS` and `SEM_TICK_SIZE` values. The master reports lot units of `1` for every selected MCX contract and tick values of `10` or `100`; their exchange quantity/price scaling was not independently confirmed against MCX contract specifications. Do not interpret these as physical contract multipliers or normalize the tick values without that check.

`NATURALGASM` is not the master `SM_SYMBOL_NAME`; it maps to `NATGASMINI` and is identified by `SEM_CUSTOM_SYMBOL` beginning `NATURALGASM `. This alias is included explicitly in the extraction evidence.

## Feed Probe

The temporary probe extracted the six security IDs and was invoked at `2026-11-24 00:51 IST`, outside the assumed MCX weekday commodity session. It therefore **skipped opening a websocket**; zero ticks in the evidence means “not measured,” not “the contracts produce no ticks.” The feed summary records all six planned subscriptions, `MCX_COMM`, and Dhan request code `21`: [`mcx-feed-summary.json`](mcx-spike-evidence/mcx-feed-summary.json). The raw tick file is empty because no session capture ran: [`mcx-feed-ticks.jsonl`](mcx-spike-evidence/mcx-feed-ticks.jsonl).

There is also a provider limitation relevant to future implementation: `SEG_BYTE` already contains `MCX_COMM: 5`, but `server/providers/dhan.mjs` currently builds its futures map only from `SEM_SEGMENT === 'D'`; the selected MCX rows are segment `M`. The existing `createDhanProvider` cannot boot with these six as commodity subscriptions without a production change. The temporary read-only probe was designed to subscribe directly to `MCX_COMM` so production code could remain untouched, but the out-of-session guard prevented the connection attempt.

No tick count, OI presence/sample, or LTP updates/sec can be reported from this run. Those fields remain null in the feed summary.

## REST Probe

One `POST /v2/charts/intraday` was attempted for NATURALGAS securityId `574319`, segment `MCX_COMM`, instrument `FUTCOM`, interval `1`, OI enabled, and date `2026-11-24`. DNS resolution failed before an HTTP response (`ENOTFOUND api.dhan.co`), so today's candles were **not confirmed**. The request and failure are recorded in [`mcx-rest-intraday.json`](mcx-spike-evidence/mcx-rest-intraday.json).

## Sessions And Holidays

The standard published non-agricultural MCX schedule is 09:00-23:30 IST in the summer window and 09:00-23:55 IST in the winter window. This is recorded as provisional in [`mcx-trading-hours.json`](mcx-spike-evidence/mcx-trading-hours.json); the current MCX circular could not be fetched to verify the schedule or season transition dates.

The local NSE holiday dates are extracted from `src/lib/marketSession.ts` in [`nse-holidays-local.json`](mcx-spike-evidence/nse-holidays-local.json). It marks `2026-11-24` as a holiday. The official MCX 2026 holiday list could not be retrieved, so no MCX-vs-NSE date diff is asserted; [`mcx-holiday-diff.json`](mcx-spike-evidence/mcx-holiday-diff.json) records the missing source and the unverified comparison.

Outbound access attempts and errors are retained in [`source-access.json`](mcx-spike-evidence/source-access.json). No credentials or credential-bearing headers were saved.

## Scope And Resume Conditions

- `scripts/mcx-feed-probe.mjs` was a throwaway direct-feed probe, not a change to `createDhanProvider`; it has been deleted after generating the evidence.
- `public/underlyings.json`, `server/providers/dhan.mjs`, `src/lib/marketSession.ts`, and the service were not modified.
- To complete the live portion, rerun the temporary feed probe during a confirmed MCX trading session with outbound DNS/network access, then retry the single charts endpoint and retrieve the official MCX 2026 holiday circular before publishing a calendar diff.
