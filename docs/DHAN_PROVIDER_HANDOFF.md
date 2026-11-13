# DHAN PROVIDER — HANDOFF FOR CODEX (continue here)

You are continuing work on **Order Flow** (`https://github.com/MrChartist/order-flow`), a live F&O
market board for Indian markets, running **live on Dhan** (user has a paid Dhan API account).
Everything below was built and verified on 2026-11-13. Read this file fully before changing code.

## 0. Ground rules

- Do NOT commit `.env` or `data/.dhan-master.csv` (both git-ignored; keep it that way).
- Do NOT edit `src/` (the page) unless the task explicitly requires it — the provider is the
  integration surface, and the page is upstream code that already works.
- License is PolyForm Noncommercial — personal use only.
- Node >= 22.18 (machine has 22.23.2). Plain ESM, no TypeScript on the server.

## 1. Architecture in one paragraph

The React page talks only to its own Node server (`server/index.mjs`, port 8787; Vite dev page on
5195 proxies `/api`). The server's data comes from one **provider** object implementing
`init() / expiries(u) / optionChain(u, expiry) / futures(u, session)` — the contract is
`server/providers/types.mjs` (units: **rupees, shares, epoch-ms, candle START times, ascending**).
`server/providers/dhan.mjs` is the Dhan adapter: a **hybrid WebSocket + REST** design.

## 2. How dhan.mjs works (the file you will touch)

- **Instruments**: Dhan's public scrip master `https://images.dhan.co/api-scrip-master.csv`
  (27 MB, refreshed ~8 am & 1 pm IST). Cached on disk at `data/.dhan-master.csv` (2 h TTL) because
  Dhan **403s repeat downloads by IP**. Parsed into: index ids (segment `I`), NSE equity ids
  (segment `E`, `EQUITY`), F&O futures (`…-FUT` rows) and per-expiry strike maps (option rows:
  base = trading symbol minus last 3 hyphen-parts, e.g. `BAJAJ-AUTO-Nov2026-12400-PE` →
  `BAJAJ-AUTO`). Alias maps: `SENSEX50→SNSX50` (index row name), `L&T→LT`,
  `ICICIPRULI→ICICILIFE`. `BAJAJHLDNG` and `DALBHARAT` have **no F&O rows in Dhan's master**
  (board on spot only) — expected warning at boot.
- **Live feed**: up to 5 WebSockets/user; this provider uses 4
  (`wss://api-feed.dhan.co?version=2&token=…&clientId=…&authType=2`; fallback host
  `ws-feed.dhan.co`). Conn 0 = underlyings + futures (~645 instruments); conns 1-3 = option
  strikes (nearest expiry, ±15 strikes around spot, rebalanced every 60 s when spot drifts
  >0.4%). Subscribe = JSON `{RequestCode:21, InstrumentCount, InstrumentList:[{ExchangeSegment,
  SecurityId}]}`, ≤100 instruments per message, batches paced 150 ms. Unsubscribe = RequestCode 22.
- **Binary packets** (little-endian, sizes in `PACKET_SIZE`): 2 Ticker 16B, 4 Quote 50B,
  5 OI 12B, 6 PrevClose 16B, 7 Status 8B, 8 FULL 162B, 50 Disconnect 10B. Header: [0]=code,
  [1-2]=message length, [3]=exchange-segment byte (`IDX_I=0, NSE_EQ=1, NSE_FNO=2, BSE_EQ=4,
  BSE_FNO=8`), [4-7]=securityId u32. FULL has LTP/OI/OHLC/depth — top-of-book: bidQty@62,
  askQty@66, bid@74, ask@78. Packets concatenate in one frame — parse in a loop; unknown codes
  fall back to the header's declared length (logged once per code).
- **Futures candles**: aggregated locally per contract into minute buckets (`futTicks`), merged
  with a once-per-session REST backfill (`futRest` → `POST /charts/intraday` + `/charts/historical`)
  so the day starts at 09:15. Failed backfills retry on later calls, but never during a
  20 s charts cooldown (`chartsCooldownUntil`, set on 429) — un-paced retries kept Dhan's charts
  limiter saturated and contracts permanently missed prevOi.
- **prev-day OI seed** (`runSeedLoop` / `seedPrevDayOi`): the feed does NOT carry prev-day OI by
  strike mid-session, and the board's big cards need it. A background sweep POSTs `/optionchain`
  once per underlying (~1 req/3 s ≈ 11 min for all 215) and writes `previous_oi`,
  `previous_close_price`, `previous_volume`, `implied_volatility`, `greeks.delta` into the live
  state of every subscribed strike. Re-seeds symbols whose window changed on rebalance.
- **Quotes**: indices are NOT broadcast on the feed (IDX_I gets zero packets — verified). One
  batched `POST /marketfeed/quote` per minute (all underlyings ≤1000 ids; 1 req/s limit) keeps
  index spots + prevClose backups fresh.
- **Chain fallback**: if the feed is unhealthy or a non-nearest expiry is requested, `optionChain`
  falls back to `POST /optionchain` behind `chainGate` — **~1 request per 3 seconds GLOBAL**
  (Dhan rejects bursts with 429/error 805 and warns about blocking; the documented
  "10 unique scrips/8 s" cap is NOT the effective limit — bursts fail regardless).
- **Watchdog**: per-connection silence >45 s (or 60 s without any packet after open) force-closes
  the socket so `onclose` reconnects (half-open sockets otherwise go unnoticed). After 3 min from
  first connect, bare/sparse chains are served from the feed instead of throwing "warming up".

## 3. Dhan API gotchas (all verified the hard way — do not re-learn these)

1. Docs SPA (docs.dhanhq.co) serves the same shell for every URL. Full export:
   `https://docs.dhanhq.co/docs-export.md` (424 KB). SDK reference: `dhan-oss/DhanHQ-py`.
2. `/optionchain` rate limit is effectively 1 req/3 s GLOBAL. Bursts → 429 `DH-904`/`805`
   "may result in the user being blocked".
3. Charts endpoints (`/charts/intraday`, `/charts/historical`) return **bare arrays**
   (`{open:[],…}`), NOT the `{status, data}` wrapper — `post()` unwraps conditionally.
4. Daily-candle timestamps are **midnight IST of the trade date**; `toDate` must be the session
   itself (passing yesterday returns data missing the previous session).
5. WS PrevClose packets (code 6) only arrive on overnight subscriptions — never mid-session.
   Futures prevClose = FULL packet's `close` field; futures prevOi needs the REST backfill.
6. Indices: zero WS packets on IDX_I. Index spots come from the per-minute quotes call.
7. Intraday charts: `POST /charts/intraday` with `{securityId (string), exchangeSegment,
   instrument: 'FUTIDX'|'FUTSTK', interval: 1, oi: true, fromDate, toDate}` — arrays incl.
   `open_interest`; timestamps epoch **seconds**, minute START.
8. Request headers: `access-token`, `client-id`, `Content-Type: application/json`. 401/807 = token
   expired (regenerate at web.dhan.co → My Profile → DhanHQ Trading Access; ~30 days on paid plan).

## 4. Env & boot

`.env` (from `.env.example`): `MF_PROVIDER=dhan`, `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN`,
optional `DHAN_MAX_RPS` (default 5), `DHAN_FUTURES_MONTHS` (default 2). The repo never loaded
`.env` on its own — `--env-file-if-exists=.env` was added to the node scripts in `package.json`
and to the server spawn in `scripts/dev.mjs`. Without that, credentials silently don't load.

## 5. Verification (run these after any change)

```bash
npm test                     # 98 tests, must stay green
npm run check:provider       # live contract check on NIFTY/BANKNIFTY/HDFCBANK/RELIANCE/TCS
curl -s localhost:5195/api/status | jq .lastBuild      # expect series 215, failed 0 (market hours)
curl -s localhost:5195/api/futures/NIFTY?session=$(date +%F)   # candles grow 1/min, prevOi set
```
prevOi coverage spot-check: `GET /api/market`, count legs (rows in `.r`) whose index-5 prevOi is
non-null — expect 100% after the seed completes.

## 6. Known state & TODOs

- Verified live 2026-11-13: 215/215 series per build (6-15 s builds), candles tick per minute,
  prevOi 100% after seed. After-hours builds may show ~19 failed (chains fall to REST while the
  feed is quiet) — cosmetic, board is frozen at close anyway. **TODO candidate**: serve the last
  known live chain after hours instead of REST re-fetching.
- Big "featured" cards render only at ≥90% futures settled on the page
  (`FEATURED_HOLD_SHARE = 0.9` in `src/features/market-flow/marketFlowModel.ts`) — after a page
  refresh there is a 2-3 min window with no big cards. By design; don't "fix".
- Universe: 217 underlyings in `public/underlyings.json`; trimming it is the sanctioned way to
  reduce load (README sanctions this).
- If builds fail mid-session: check server log for `429`, `silent`, `unhandled feed packet`;
  prev-day seed runs every 60 s pass and self-heals.

## 7. Replay V1 — known limitations (verified 2026-11-13, acknowledged by implementer)

| # | Limitation | Status / deadline |
|---|---|---|
| G1 | Post-close, chains with sparse live state fall to REST and can 429 → builds show 196–211/215 instead of 215/0. Provider-side: prefer the cached last-chain once prev-day seed is complete. | Open, cosmetic after close only |
| G2 | Playwright E2E not runnable yet — browser install failed (registry DNS); ports 8787/5195 hardcoded (conflicts with a running live board). | **Must run before replay is "done":** `npx playwright install chromium`, stop the live board, `npm run test:e2e` |
| G3 | No playback speed control — fixed 700 ms per minute (~86× speed) in `useReplayFlow.ts`. | Accepted V1 deviation; V1.1 candidate |
| G4 | Client clips replay timeline at 15:30 (`SESSION_END_MINUTE`) while capture/serving reaches the date-aware derivatives close (15:40). 10 minutes captured but unreachable in replay. | Accepted per V1 guardrail; revisit in V1.1 — one-line change in `boardReplayMinutes` to use `marketSessionBounds(date).close` |
| G5 | E2E fixture expiry hardcoded `2026-11-24` (`tests/e2e/start.mjs`) — fixture degrades after that date. | **Deadline 2026-11-24:** make fixture expiries dynamic (today + 7d) before then |
| G6 | Futures persistence is page-driven — no page open during market hours = prices-only capture. Server-side capture cycle is a V1.1 item. | Accepted V1; operational note: keep the board open during sessions you want replayable |

These are documented V1 scope decisions, not regressions. G2 and G5 are time-critical; the rest are queued for V1.1.
