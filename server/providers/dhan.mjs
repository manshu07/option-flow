/**
 * Dhan (https://dhanhq.co — DhanHQ v2: REST + Live Market Feed over WebSocket).
 *
 * Setup:
 *   MF_PROVIDER=dhan
 *   DHAN_CLIENT_ID=<your client id, shown next to the avatar on web.dhan.co>
 *   DHAN_ACCESS_TOKEN=<My Profile → DhanHQ Trading Access → Generate New Token>
 *
 * Architecture — REST seeds once, the WebSocket feed carries the day:
 *   instruments  Dhan's public scrip master (api-scrip-master.csv), read once at
 *                start: universe symbol → underlying security id, futures
 *                contracts, option strikes per expiry. No auth, no API quota.
 *   websocket    up to 5 connections × 5,000 instruments are allowed per user;
 *                this provider uses 4: underlyings + futures on the first,
 *                option strikes (~31 strikes × CE/PE around spot per
 *                underlying, nearest expiry) on the other three. Every
 *                subscription arrives with a PrevClose packet — previous day's
 *                close AND open interest — so the previous session needs no
 *                REST at all. FULL packets (code 8) carry LTP, OI, OHLC and
 *                top-of-book per tick; futures candles are aggregated locally.
 *   expiries     from the master (no API call).
 *   optionChain  for the nearest expiry: synthesised live from the feed (iv and
 *                delta are not on the feed, so they stay null — the board
 *                doesn't use them). Any other expiry, or a feed that hasn't
 *                warmed up, falls back to POST /optionchain behind the chain
 *                gate (documented: 1 request / 3 s per scrip+expiry, 10 unique
 *                scrips / 8 s — bursts are rejected regardless of the caps).
 *   full-chain   the existing paced seed/fallback responses are retained as
 *                timestamped full-expiry snapshots; they do not widen the live
 *                subscription window or feed stale quotes into alert rules.
 *   futures      today's session: 1-minute candles built from the feed's ticks;
 *                an earlier session: POST /charts/intraday (last 5 trading
 *                days). prevClose/prevOi from the feed's PrevClose packets, or
 *                one POST /charts/historical per contract when they have not
 *                arrived yet.
 *
 * Documented REST rate limits, still enforced for the seed and fallback calls:
 *   Data APIs 5 req/sec (100,000/day) · Market Quote 1 req/sec, 1,000
 *   instruments/request (the whole universe goes in ONE request) · HTTP 429 →
 *   one retry after 3 s. Spot for the strike windows is seeded with that single
 *   quote request at start; after that the board runs on the feed.
 *
 * NIFTY is scrip 13 on IDX_I, BANKNIFTY 25, FINNIFTY 27, MIDCPNIFTY 442,
 * NIFTYNXT50 38; SENSEX 51 and BANKEX 69 on BSE (also IDX_I), FOCIT 850;
 * SENSEX50's index row is named SNSX50. Stock underlyings chain and quote on
 * NSE_EQ through their equity security id. Dhan's master names a few
 * underlyings differently (L&T → LT, ICICIPRULI → ICICILIFE); BAJAJHLDNG and
 * DALBHARAT carry no F&O rows in the master at all, so they board on spot
 * moves only. A daily restart (the master refreshes and contracts roll) keeps
 * the instrument map current.
 */
const API = 'https://api.dhan.co/v2';
const MASTER = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const FEED_HOSTS = ['wss://api-feed.dhan.co', 'wss://ws-feed.dhan.co'];
/** The master is ~27 MB and Dhan throttles repeat downloads by IP: cache it on
 *  disk and refresh at most every two hours (Dhan publishes it ~8 am and 1 pm IST). */
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMarketSessionTime } from '../../src/lib/marketSession.ts';
import { createFullOptionChainSnapshot, normalizeDhanOptionChain } from '../optionChainSnapshots.mjs';
import { readFutures } from '../replayStorage.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASTER_CACHE = path.join(ROOT, 'data', '.dhan-master.csv');
const MAX_PER_SECOND = Math.max(1, Number(process.env.DHAN_MAX_RPS) || 5);
const FUTURES_MONTHS = Math.max(1, Math.min(3, Number(process.env.DHAN_FUTURES_MONTHS) || 2));
const CHAIN_PER_8S = 10; // documented hard cap; do not raise
const STRIKES_EACH_SIDE = 15;
// Next-expiry capture (December spec): a narrower second window on the expiry
// after the near one, so cards can sit on the slower-decaying month.
// DHAN_NEXT_EXPIRY=0 disables everything; DHAN_NEXT_STRIKES sizes the window.
const NEXT_EXPIRY_ENABLED = process.env.DHAN_NEXT_EXPIRY !== '0';
const NEXT_EXPIRY_STRIKES_EACH_SIDE = Number(process.env.DHAN_NEXT_STRIKES) || 7;
// Dhan hard caps: 5 connections × 5,000 instruments. Never subscribe past this;
// the December window trims ±7 → ±5 → ±3, then drops entirely (near chain wins).
const FEED_INSTRUMENT_CAP = 24_500;
const QUOTES_EVERY_MS = 60_000;

/** Universe symbols Dhan names differently in its scrip master. */
const INDEX_ALIAS = { SENSEX50: 'SNSX50' };
const EQUITY_ALIAS = { 'L&T': 'LT', ICICIPRULI: 'ICICILIFE' };
/** Exchange segment names → the byte the feed puts in its packets (and back). */
const SEG_BYTE = { IDX_I: 0, NSE_EQ: 1, NSE_FNO: 2, NSE_CURRENCY: 3, BSE_EQ: 4, MCX_COMM: 5, BSE_CURRENCY: 7, BSE_FNO: 8 };
const SEG_NAME = Object.fromEntries(Object.entries(SEG_BYTE).map(([k, v]) => [v, k]));
/** Fixed binary packet sizes by feed response code (docs: Live Market Feed). */
const PACKET_SIZE = { 2: 16, 3: 112, 4: 50, 5: 12, 6: 16, 7: 8, 8: 162, 50: 10 };
const DROP_REASON = { 805: 'connection limit exceeded', 806: 'Data APIs subscription required', 807: 'access token expired', 808: 'invalid client id', 809: 'authentication failed' };
/** Packet codes we have logged as unhandled, so the warning fires once per code. */
const unhandledCodes = new Set();

const ymdIst = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const ymd = s => (typeof s === 'string' ? s.slice(0, 10) : s);
const istMinute = ms => Math.floor((ms + 330 * 60_000) / 60_000) * 60_000 - 330 * 60_000;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Minimal CSV reader: quoted fields, CRLF, no multiline cells (the master has none). */
function* csvRows(text) {
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) yield row;
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); yield row; }
}

export function createDhanProvider(universe) {
  const clientId = process.env.DHAN_CLIENT_ID;
  const token = process.env.DHAN_ACCESS_TOKEN;
  /** symbol → { symbol, kind, underlyingId, underSeg, exchSeg, fut, expiries, optionStrikes } */
  const map = new Map();
  /** 'seg:id' → latest feed readings: ltp, prevClose, prevOi, oi, volume, avgPrice, bid/ask(+qty), open/high/low/close, t */
  const live = new Map();
  /** contractId → Map(minuteStartMs → { close, oi }) — today's futures candles, tick by tick. */
  const futTicks = new Map();
  /** contractId → Promise<{ prevClose, prevOi, candles }> — one REST backfill per
   *  contract per session: prev-day figures (the feed only sends PrevClose
   *  packets on overnight subscriptions, not mid-session) and the session's
   *  minute candles from 09:15, which the feed's live ticks then extend. */
  const futRest = new Map();
  /** After a charts 429, hold off backfill retries for a while: the page's
   *  2-minute futures cycle re-asks every contract, and un-paced retries keep
   *  the limiter saturated so some contracts never backfill at all. */
  let chartsCooldownUntil = 0;
  /** symbol → { expiry, at, chain } — the last good option chain, served after
   *  the session closes (the feed goes quiet; re-fetching over paced REST turns
   *  every build into an eleven-minute crawl for unchanged data). */
  const lastChain = new Map();
  /** Full responses already fetched by the paced seed/fallback path, by symbol. */
  const fullChains = new Map();
  /** symbol+session → underlying's previous close, when neither the feed nor quotes had it. */
  const prevCloseCache = new Map();
  /** Whole-universe quotes (one REST request per refresh): seg → id → { last_price, ohlc }. */
  let quotes = null, quotesAt = 0, quotesInFlight = null;
  /** Global Data-API bucket (5 requests a second) for every REST call. */
  let slots = [];
  /** Option-Chain gate: at most CHAIN_PER_8S requests in any 8-second window. */
  let chainStamps = [];
  /** Auth-failure handling: 401s back off for 5 minutes (one warning per episode) instead
   *  of spamming every retry — an expired token used to flood the log all night. */
  let authFailUntil = 0;
  let authWarned = false;
  /** The feed: one connection for underlyings + futures, the rest for option strikes. */
  const conns = [];
  let feedHealthyAt = 0, feedStartedAt = 0, feedWant = new Set(), rebalanceTimer = null, watchdogTimer = null;
  // Resource ledger (owner ask): every REST call, WS packet, and the heap are
  // counted so usage jumps are traceable instead of guessed at.
  const usage = {
    startedAt: Date.now(),
    restCalls: 0, rest429: 0,
    packets: 0, packetBytes: 0,
    lastHeapMb: 0, peakHeapMb: 0,
  };
  const usageTick = () => {
    const heapMb = process.memoryUsage().heapUsed / 1_048_576;
    usage.lastHeapMb = Math.round(heapMb);
    usage.peakHeapMb = Math.max(usage.peakHeapMb, Math.round(heapMb));
    console.log(`dhan: usage 5m — rest ${usage.restCalls} (429s ${usage.rest429}), ws ${usage.packets} pkts/${Math.round(usage.packetBytes / 1_048_576)}MB, heap ${usage.lastHeapMb}MB (peak ${usage.peakHeapMb}MB)`);
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function throttle() {
    for (;;) {
      const now = Date.now();
      slots = slots.filter(t => now - t < 1000);
      if (slots.length < MAX_PER_SECOND) { slots.push(now); return; }
      await sleep(1000 - (now - slots[0]) + 10);
    }
  }

  async function chainGate() {
    // Dhan rejects bursts of option-chain requests no matter the documented caps;
    // in practice ~1 request every 3 s is what passes. Fallback calls only, so
    // the pacing costs nothing on a normal day.
    for (;;) {
      const now = Date.now();
      chainStamps = chainStamps.filter(t => now - t < 8000);
      if (chainStamps.length >= CHAIN_PER_8S) { await sleep(8000 - (now - chainStamps[0]) + 20); continue; }
      const gap = chainStamps.length ? now - chainStamps[chainStamps.length - 1] : Infinity;
      if (chainStamps.length && gap < 3000) { await sleep(3000 - gap); continue; }
      chainStamps.push(Date.now());
      await throttle();
      return;
    }
  }

  async function post(path, payload, { retry = true, timeoutMs = 20_000 } = {}) {
    if (Date.now() < authFailUntil) throw new Error('Dhan credentials rejected earlier — cooling down before retrying.');
    await throttle();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'access-token': token, 'client-id': clientId },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (retry) { await sleep(1000); return post(path, payload, { retry: false, timeoutMs }); }
      throw error;
    }
    if (res.status === 401 || res.status === 807) {
      authFailUntil = Date.now() + 5 * 60_000;
      if (!authWarned) {
        authWarned = true;
        console.warn('⚠️ Dhan rejected the credentials (401) — generate a fresh access token on web.dhan.co → My Profile → DhanHQ Trading Access, update .env, and restart. API calls paused for 5 minutes.');
      }
      throw new Error('Dhan rejected the credentials (HTTP 401). Generate a fresh access token on web.dhan.co → My Profile → DhanHQ Trading Access.');
    }
    if (res.status === 429 && retry) { usage.rest429 += 1; await sleep(3000); return post(path, payload, { retry: false, timeoutMs }); }
    if (!res.ok) throw new Error(`Dhan ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    // Chart endpoints answer with the payload itself; the rest wrap it in { status, data }.
    if (!('status' in body)) return body;
    if (body.status === 'failure') throw new Error(`Dhan ${path}: ${JSON.stringify(body.remarks ?? body.errorMessage ?? body).slice(0, 200)}`);
    return body.data;
  }

  const entry = symbol => {
    const held = map.get(symbol);
    if (!held) throw new Error(`Dhan has no instruments for ${symbol}`);
    return held;
  };

  // ── Live feed state ────────────────────────────────────────────────────────

  function record(segByte, securityId, patch) {
    const key = `${segByte}:${securityId}`;
    const held = live.get(key) ?? { segByte, id: securityId };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && !(v === 0 && (k === 'prevClose' || k === 'prevOi') && held[k])) held[k] = v;
    if (held.ltp > 0 || held.prevClose > 0 || held.oi > 0 || held.prevOi > 0) live.set(key, held);
    return held;
  }

  function noteTick(segByte, securityId, price, oi, volume) {
    if (!price) return;
    const now = Date.now();
    const minute = istMinute(now);
    const held = futTicks.get(securityId);
    if (held) {
      const candle = held.get(minute) ?? {};
      if (candle.open === undefined) candle.open = price;
      candle.close = price;
      candle.high = Math.max(candle.high ?? price, price);
      candle.low = Math.min(candle.low ?? price, price);
      if (oi !== undefined) candle.oi = oi;
      else if (candle.oi === undefined) candle.oi = 0;
      // Dhan's tick volume is the day's cumulative figure; one minute's volume
      // is the delta from the minute's first cumulative reading. The start is
      // kept off the candle body so it never reaches the persisted file.
      if (Number.isFinite(volume) && volume >= 0) {
        if (candle.volStart === undefined) candle.volStart = volume;
        candle.volume = Math.max(0, volume - candle.volStart);
      }
      held.set(minute, candle);
    }
  }

  function parseFeed(buf) {
    usage.packets += 1;
    usage.packetBytes += buf.length;
    let off = 0;
    while (off + 8 <= buf.length) {
      const code = buf.readUInt8(off);
      let size = PACKET_SIZE[code];
      if (!size) {
        // Not in the documented table (e.g. 1 = Index Packet): trust the header's
        // declared message length so the rest of the message still parses.
        const declared = buf.readUInt16LE(off + 1);
        if (!unhandledCodes.has(code)) {
          unhandledCodes.add(code);
          console.warn(`dhan: unhandled feed packet code ${code}, declared ${declared} bytes (skipping)`);
        }
        size = declared > 8 && declared <= buf.length - off ? declared : 0;
        if (!size) break;
      }
      if (off + size > buf.length) break;
      if (code === 50) {
        const reason = DROP_REASON[buf.readUInt16LE(off + 8)] ?? `code ${buf.readUInt16LE(off + 8)}`;
        console.warn(`dhan: feed dropped us: ${reason}`);
        break;
      }
      const seg = buf.readUInt8(off + 3);
      const id = buf.readUInt32LE(off + 4);
      if (code === 2) {
        const price = buf.readFloatLE(off + 8);
        record(seg, id, { ltp: price });
        noteTick(seg, id, price);
      } else if (code === 6) {
        record(seg, id, { prevClose: buf.readFloatLE(off + 8), prevOi: buf.readUInt32LE(off + 12) });
      } else if (code === 4) {
        const ltp = buf.readFloatLE(off + 8);
        record(seg, id, {
          ltp, avgPrice: buf.readFloatLE(off + 18), volume: buf.readUInt32LE(off + 22),
          open: buf.readFloatLE(off + 34), close: buf.readFloatLE(off + 38),
          high: buf.readFloatLE(off + 42), low: buf.readFloatLE(off + 46),
        });
        noteTick(seg, id, ltp, undefined, buf.readUInt32LE(off + 22));
      } else if (code === 5) {
        const oi = buf.readUInt32LE(off + 8);
        record(seg, id, { oi });
        if (futTicks.has(id)) {
          const held = futTicks.get(id);
          const minute = istMinute(Date.now());
          const candle = held.get(minute) ?? {};
          candle.oi = oi;
          if (candle.close === undefined) {
            const ltp = live.get(`${seg}:${id}`)?.ltp ?? 0;
            if (ltp > 0) {
              candle.open = candle.open ?? ltp;
              candle.high = candle.high ?? ltp;
              candle.low = candle.low ?? ltp;
            }
            candle.close = ltp;
          }
          held.set(minute, candle);
        }
      } else if (code === 8) {
        const ltp = buf.readFloatLE(off + 8);
        const oi = buf.readUInt32LE(off + 34);
        // Depth: 5 × 20-byte entries <IIHHff> from byte 62 — entry 0's top-of-book.
        record(seg, id, {
          ltp, oi, avgPrice: buf.readFloatLE(off + 18), volume: buf.readUInt32LE(off + 22),
          bidQty: buf.readUInt32LE(off + 62), askQty: buf.readUInt32LE(off + 66),
          bid: buf.readFloatLE(off + 74), ask: buf.readFloatLE(off + 78),
          open: buf.readFloatLE(off + 46), close: buf.readFloatLE(off + 50),
          high: buf.readFloatLE(off + 54), low: buf.readFloatLE(off + 58),
        });
        noteTick(seg, id, ltp, oi, buf.readUInt32LE(off + 22));
      }
      // code 7 (market status) and 3 (v1 depth) carry nothing we need.
      off += size;
    }
  }

  function feedHealthy() {
    return conns.some(c => c.socket && c.socket.readyState === 1) && feedHealthyAt > 0 && Date.now() - feedHealthyAt < 15_000;
  }

  function pickConn(reserve) {
    let best = null;
    for (let i = 0; i < conns.length; i++) {
      const c = conns[i];
      if (!c.socket || c.socket.readyState !== 1) continue;
      if (reserve === 'core' && i !== 0) continue;
      if (reserve === 'options' && i === 0) continue;
      if (!best || c.subs.size < best.subs.size) best = c;
    }
    return best;
  }

  async function sendSub(conn, keys, code) {
    if (!keys.length || conn.socket?.readyState !== 1) return;
    const batch = keys.slice(0, 100).map(key => {
      const [segByte, id] = key.split(':');
      return { ExchangeSegment: SEG_NAME[Number(segByte)], SecurityId: String(id) };
    });
    conn.socket.send(JSON.stringify({ RequestCode: code, InstrumentCount: batch.length, InstrumentList: batch }));
  }

  function subscribe(keys, reserve) {
    for (const key of keys) {
      feedWant.add(key);
      const conn = pickConn(reserve) ?? pickConn();
      if (!conn) continue;
      if (conn.subs.has(key)) continue;
      conn.subs.add(key);
      conn.queue.push(key);
    }
    drainQueues();
  }

  function unsubscribe(keys) {
    for (const key of keys) {
      feedWant.delete(key);
      const conn = conns.find(c => c.subs.delete(key));
      if (conn?.socket?.readyState === 1) conn.unsubQueue.push(key);
    }
    drainQueues();
  }

  async function drainQueues() {
    for (const conn of conns) {
      if (conn.draining || conn.socket?.readyState !== 1) continue;
      conn.draining = true;
      try {
        // Up to 100 instruments per JSON message, a few messages a second.
        let sent = 0;
        while (conn.queue.length) {
          const batch = conn.queue.splice(0, 100);
          sendSub(conn, batch, 21);
          sent += batch.length;
          await sleep(150);
        }
        while (conn.unsubQueue.length) {
          const batch = conn.unsubQueue.splice(0, 100);
          sendSub(conn, batch, 22);
          await sleep(150);
        }
        if (sent) console.log(`dhan: feed subscribed ${sent} instruments (subs now ${conn.subs.size})`);
      } finally {
        conn.draining = false;
      }
    }
  }

  async function openConn(index, hostIdx = 0) {
    if (index >= conns.length) return;
    const conn = conns[index];
    const host = FEED_HOSTS[hostIdx % FEED_HOSTS.length];
    const url = `${host}?version=2&token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      console.warn(`dhan: feed ${index} failed to open: ${error?.message || error}`);
      return scheduleReconnect(conn, hostIdx + 1);
    }
    socket.binaryType = 'arraybuffer';
    conn.socket = socket;
    conn.lastPacketAt = 0;
    conn.packets = 0;
    conn.openedAt = Date.now();
    conn.subs = new Set();
    conn.queue = [];
    conn.unsubQueue = [];
    socket.onopen = async () => {
      conn.reconnectAttempts = 0;
      if (!feedStartedAt) feedStartedAt = Date.now();
      console.log(`dhan: feed ${index} connected (${host.replace('wss://', '')})`);
      const mine = [...feedWant].filter(key => conn.holds?.has(key));
      for (const key of mine) conn.subs.add(key);
      conn.queue.push(...conn.subs);
      drainQueues();
    };
    socket.onmessage = event => {
      feedHealthyAt = Date.now();
      conn.lastPacketAt = Date.now();
      conn.packets = (conn.packets ?? 0) + 1;
      if (typeof event.data === 'string') return;
      const buf = Buffer.from(new Uint8Array(event.data));
      parseFeed(buf);
    };
    socket.onclose = () => {
      conn.socket = null;
      scheduleReconnect(conn, hostIdx);
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect(conn, hostIdx) {
    if (conn.reconnectTimer) return;
    // Exponential backoff so a refusing endpoint is never hammered — Dhan
    // throttling rapid reconnect loops would hurt the next market session.
    const delay = Math.min(3_000 * 2 ** (conn.reconnectAttempts ?? 0), 60_000);
    conn.reconnectAttempts = (conn.reconnectAttempts ?? 0) + 1;
    conn.reconnectTimer = setTimeout(async () => {
      conn.reconnectTimer = null;
      await openConn(conns.indexOf(conn), hostIdx + 1);
    }, delay);
  }

  // ── Quotes and previous closes (REST, sparingly) ──────────────────────────

  async function ensureQuotes() {
    if (quotes && Date.now() - quotesAt < QUOTES_EVERY_MS) return quotes;
    if (quotesInFlight) return quotesInFlight;
    const bySeg = new Map();
    for (const held of map.values()) {
      if (held.underlyingId == null) continue;
      if (!bySeg.has(held.underSeg)) bySeg.set(held.underSeg, []);
      bySeg.get(held.underSeg).push(held.underlyingId);
    }
    quotesInFlight = (async () => {
      const body = {};
      for (const [seg, ids] of bySeg) body[seg] = ids.slice(0, 1000);
      const fresh = {};
      try {
        const data = await post('/marketfeed/quote', body);
        for (const [seg, ids] of Object.entries(data ?? {})) {
          fresh[seg] = {};
          for (const [id, q] of Object.entries(ids ?? {})) fresh[seg][id] = q;
        }
      } catch (error) {
        console.warn(`dhan: quote refresh failed: ${error?.message || error}`);
      }
      if (Object.keys(fresh).length) { quotes = fresh; quotesAt = Date.now(); }
      return quotes;
    })();
    try {
      return await quotesInFlight;
    } finally {
      quotesInFlight = null;
    }
  }

  function underlyingQuote(held) {
    const feed = live.get(`${SEG_BYTE[held.underSeg]}:${held.underlyingId}`);
    const q = quotes?.[held.underSeg]?.[String(held.underlyingId)];
    const spot = feed?.ltp || num(q?.last_price) || null;
    const prevClose = feed?.prevClose || num(q?.ohlc?.close) || null;
    return { spot, prevClose };
  }

  /** Fallback when neither the feed nor quotes carry an underlying's previous close. */
  async function underlyingPrevClose(held, session) {
    const key = `${held.symbol}:${session}`;
    if (prevCloseCache.has(key)) return prevCloseCache.get(key);
    let prev = null;
    try {
      const data = await post('/charts/historical', {
        securityId: String(held.underlyingId), exchangeSegment: held.underSeg,
        instrument: held.kind === 'index' ? 'INDEX' : 'EQUITY', expiryCode: 0, oi: false,
        fromDate: ymdIst(Date.parse(`${session}T00:00:00+05:30`) - 10 * 86_400_000), toDate: session,
      });
      const stamps = (data?.timestamp ?? []).map(Number);
      for (let i = stamps.length - 1; i >= 0; i--) {
        if (ymdIst(stamps[i] * 1000) < session) { prev = num(data.close?.[i]); break; }
      }
    } catch { /* leave null */ }
    prevCloseCache.set(key, prev);
    return prev;
  }

  // ── Chains ────────────────────────────────────────────────────────────────

  function legFromFeed(key) {
    const held = live.get(key);
    if (!held) return undefined;
    const ltp = held.ltp || 0;
    return {
      ltp,
      prevClose: held.prevClose ?? held.close ?? null,
      oi: held.oi || 0,
      prevOi: held.prevOi ?? null,
      volume: held.volume || 0,
      prevVolume: held.prevVolume ?? null,
      avgPrice: held.avgPrice || ltp,
      iv: held.iv ?? null,
      bid: held.bid || 0,
      ask: held.ask || 0,
      bidQty: held.bidQty || 0,
      askQty: held.askQty || 0,
      dayHigh: held.high ?? null,
      dayLow: held.low ?? null,
      lastTradeAt: null,
      delta: held.delta ?? null,
    };
  }

  function liveChain(held, expiry) {
    const near = held.optionStrikes && held.optionStrikes.expiry === expiry ? held.optionStrikes : null;
    const next = held.nextWindow && held.nextWindow.expiry === expiry ? held.nextWindow : null;
    const source = near ?? next;
    if (!source) return null;
    const { spot, prevClose } = underlyingQuote(held);
    if (!spot) return null;
    // Option legs live on the UNDERLYING's FNO segment (NSE options on
    // NSE_FNO, Sensex/BSE legs on BSE_FNO).
    const segByte = SEG_BYTE[held.exchSeg] ?? SEG_BYTE.NSE_FNO;
    const strikes = [...source.window]
      .sort((a, b) => a - b)
      .map(strike => {
        const ceKey = source.ids.get(strike)?.CE;
        const peKey = source.ids.get(strike)?.PE;
        return {
          strike,
          call: ceKey ? legFromFeed(`${segByte}:${ceKey}`) : undefined,
          put: peKey ? legFromFeed(`${segByte}:${peKey}`) : undefined,
        };
      });
    return { expiry, at: Date.now(), spot, prevClose, atm: null, strikes };
  }

  async function restChain(u, expiry, held) {
    const [data] = await Promise.all([
      (async () => { await chainGate(); return post('/optionchain', { UnderlyingScrip: held.underlyingId, UnderlyingSeg: held.underSeg, Expiry: expiry }); })(),
      ensureQuotes(),
    ]);
    const fallback = underlyingQuote(held);
    let prevClose = fallback?.prevClose || null;
    if (!prevClose) prevClose = await underlyingPrevClose(held, ymdIst(Date.now()));
    return normalizeDhanOptionChain(data, {
      expiry,
      at: Date.now(),
      spotFallback: fallback?.spot,
      prevClose,
    });
  }

  /** Prev-day seed, once per underlying per session. The feed does not carry
   *  previous-day OI by strike mid-session (its PrevClose packets only go out on
   *  overnight subscriptions), and without it the board cannot tell which
   *  positions were OPENED today — so the big cards stay empty. One paced
   *  /optionchain call fills previous OI (plus IV and delta) into the feed
   *  state and retains the full response for a timestamped session snapshot. */
  const seeded = new Set();
  async function seedPrevDayOi(held) {
    if (seeded.has(held.symbol) || !held.optionStrikes?.expiry) return;
    seeded.add(held.symbol);
    let data;
    try {
      data = await (async () => { await chainGate(); return post('/optionchain', { UnderlyingScrip: held.underlyingId, UnderlyingSeg: held.underSeg, Expiry: held.optionStrikes.expiry }); })();
    } catch (error) {
      seeded.delete(held.symbol); // retry on a later pass
      return;
    }
    const capturedAt = Date.now();
    const quote = underlyingQuote(held);
    const chain = normalizeDhanOptionChain(data, {
      expiry: held.optionStrikes.expiry,
      at: capturedAt,
      spotFallback: quote.spot,
      prevClose: quote.prevClose,
    });
    if (chain.strikes.length) {
      fullChains.set(`${held.symbol}:${capturedAt}`, createFullOptionChainSnapshot(held.symbol, ymdIst(capturedAt), chain));
    }
    const oc = data?.oc ?? {};
    const segByte = SEG_BYTE.NSE_FNO;
    for (const [key, sides] of Object.entries(oc)) {
      const strike = Number(key);
      const ids = held.optionStrikes.ids.get(strike);
      if (!ids) continue;
      for (const [sideName, legKey] of [['CE', ids.CE], ['PE', ids.PE]]) {
        const side = sides?.[sideName === 'CE' ? 'ce' : 'pe'];
        if (!side || !legKey) continue;
        const g = side.greeks ?? {};
        record(segByte, legKey, {
          prevOi: num(side.previous_oi),
          prevClose: num(side.previous_close_price),
          prevVolume: num(side.previous_volume),
          iv: num(side.implied_volatility),
          delta: num(g.delta),
        });
      }
    }
  }

  /** Instant prev-day seed from yesterday's last captured minute snapshot: one
   *  ~1.4 MB file holds every leg's OI/close — the whole universe seeds in one
   *  read instead of the ~11-minute REST sweep. The REST seed loop still runs
   *  afterwards for IV/delta and the full-chain snapshots. */
  function seedPrevDayFromDisk(session) {
    const dataDir = path.join(ROOT, 'server', 'data', 'dhan');
    let dirs = [];
    try {
      dirs = fs.readdirSync(dataDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name <= session)
        .map(entry => entry.name)
        .sort()
        .reverse();
    } catch { return false; }
    const seedFromSeries = (series, sourceLabel) => {
      const bySymbol = new Map((Array.isArray(series) ? series : []).map(item => [item?.s, item]));
      let legs = 0;
      for (const held of map.values()) {
        const rows = bySymbol.get(held.symbol);
        if (!rows) continue;
        const rowMap = new Map((Array.isArray(rows.r) ? rows.r : []).filter(row => Array.isArray(row)).map(row => [`${row[0]}:${row[1]}`, row]));
        const legSeg = SEG_BYTE[held.exchSeg] ?? SEG_BYTE.NSE_FNO;
        const windows = [
          held.optionStrikes?.window?.length ? { window: held.optionStrikes.window, ids: held.optionStrikes.ids } : null,
          held.nextWindow?.window?.length ? { window: held.nextWindow.window, ids: held.nextWindow.ids } : null,
        ].filter(Boolean);
        for (const { window, ids } of windows) {
          for (const strike of window) {
            const legsById = ids.get(strike) ?? {};
            for (const [side, legKey] of [[0, legsById.CE], [1, legsById.PE]]) {
              const row = rowMap.get(`${strike}:${side}`);
              const prevOi = num(row?.[5]);
              if (!legKey || !row || prevOi == null) continue; // only real prev-day values count
              record(legSeg, legKey, { prevOi, prevClose: num(row[3]), prevVolume: num(row[6]) });
              legs += 1;
            }
          }
        }
      }
      if (legs > 0) console.log(`dhan: prev-day seeded from ${sourceLabel} — ${legs} legs instantly (REST seed continues for IV/delta)`);
      return legs > 0;
    };

    for (const date of dirs) {
      const dir = path.join(dataDir, date);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).sort(); } catch { continue; }
      if (!files.length) continue; // cleaned after archive — try the older day / the gz below
      let snap;
      try { snap = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')); }
      catch (error) { console.warn(`dhan: disk seed could not parse ${date}/${files[files.length - 1]}: ${error?.message || error}`); continue; }
      if (seedFromSeries(snap?.series, `${date}/${files[files.length - 1]}`)) return true;
    }

    // Raw minutes may be cleaned after archiving (or written pre-seed on a
    // restart). The day's archive gz still holds every leg's prev-day OI —
    // read its LAST minute once (~3s) instead of the 11-minute REST sweep.
    const archiveDir = path.join(ROOT, 'server', 'data', 'archives', 'dhan');
    let gzFiles = [];
    try { gzFiles = fs.readdirSync(archiveDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f) && f.slice(0, 10) <= session).sort().reverse(); } catch { /* none */ }
    for (const gz of gzFiles) {
      try {
        const payload = JSON.parse(gunzipSync(fs.readFileSync(path.join(archiveDir, gz))).toString('utf8'));
        const minutes = payload?.minutes;
        let last;
        if (Array.isArray(minutes)) last = minutes[minutes.length - 1];
        else if (minutes && typeof minutes === 'object') {
          const keys = Object.keys(minutes).sort();
          last = minutes[keys[keys.length - 1]];
        }
        const series = Array.isArray(last) ? last[1]?.series : last?.series;
        if (seedFromSeries(series, `archive ${gz}`)) return true;
      } catch (error) {
        console.warn(`dhan: disk seed could not read archive ${gz}: ${error?.message || error}`);
      }
    }
    return false;
  }

  /** Previous session's persisted near-month last candle = today's prev OI/close.
   *  Cached per symbol+session; used when the charts backfill is rate-limited. */
  const prevDayFuturesCache = new Map();
  let archiveFuturesCache = null; // symbol -> {oi,close} from the latest archive gz
  function archiveFutures() {
    if (archiveFuturesCache) return archiveFuturesCache;
    archiveFuturesCache = new Map();
    const archiveDir = path.join(ROOT, 'server', 'data', 'archives', 'dhan');
    try {
      const gz = fs.readdirSync(archiveDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort().reverse()[0];
      if (gz) {
        const payload = JSON.parse(gunzipSync(fs.readFileSync(path.join(archiveDir, gz))).toString('utf8'));
        for (const [symbol, months] of Object.entries(payload?.futures ?? {})) {
          const near = Array.isArray(months) ? months[0] : null;
          const last = Array.isArray(near?.candles) ? near.candles[near.candles.length - 1] : null;
          if (last && Number.isFinite(last.oi) && Number.isFinite(last.close)) archiveFuturesCache.set(symbol, { oi: last.oi, close: last.close });
        }
      }
    } catch { /* leave empty */ }
    return archiveFuturesCache;
  }
  function prevDayFutures(symbol, session) {
    const cacheKey = `${symbol}|${session}`;
    if (prevDayFuturesCache.has(cacheKey)) return prevDayFuturesCache.get(cacheKey);
    let result = null;
    const dataDir = path.join(ROOT, 'server', 'data', 'dhan');
    try {
      const dirs = fs.readdirSync(dataDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name < session)
        .map(e => e.name).sort().reverse();
      for (const date of dirs) {
        const file = path.join(dataDir, date, 'futures', `${symbol}.json`);
        if (!fs.existsSync(file)) continue;
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        const near = Array.isArray(payload?.months) ? payload.months[0] : null;
        const last = Array.isArray(near?.candles) ? near.candles[near.candles.length - 1] : null;
        if (last && Number.isFinite(last.oi) && Number.isFinite(last.close)) { result = { oi: last.oi, close: last.close }; break; }
      }
    } catch { /* leave null */ }
    if (!result) result = archiveFutures().get(symbol) ?? null;
    prevDayFuturesCache.set(cacheKey, result);
    return result;
  }

  async function runSeedLoop() {
    // ~1 request every 3 s: the first pass seeds the whole universe in about
    // eleven minutes, entirely inside the documented Option Chain limit. The
    // loop keeps running so strikes that join the window on a rebalance (and
    // anything that failed on a 429) get their prev-day figures too. Outside
    // market hours the loop idles — a closed market has nothing new to seed,
    // and retrying the (sometimes dead) chain endpoint all night is waste.
    for (;;) {
      if (isMarketSessionTime(Date.now())) {
        for (const held of map.values()) {
          if (!seeded.has(held.symbol)) await seedPrevDayOi(held).catch(() => undefined);
        }
      }
      await sleep(60_000);
    }
  }

  // ── Futures ───────────────────────────────────────────────────────────────

  function candlesFromFeed(contractId) {
    const held = futTicks.get(contractId);
    if (!held) return [];
    return [...held.entries()]
      .map(([at, candle]) => {
        const out = { at, open: candle.open ?? candle.close, high: candle.high ?? candle.close, low: candle.low ?? candle.close, close: candle.close, oi: candle.oi ?? 0 };
        if (Number.isFinite(candle.volume)) out.volume = candle.volume;
        return out;
      })
      .filter(c => c.close > 0 && Number.isFinite(c.oi))
      .sort((a, b) => a.at - b.at);
  }

  async function restFuturesMonth(id, held, expiry, expiryCode, instrument, session, wantMinute) {
    const from = ymdIst(Date.parse(`${session}T00:00:00+05:30`) - 14 * 86_400_000);
    const [daily, minute] = await Promise.all([
      post('/charts/historical', { securityId: String(id), exchangeSegment: held.exchSeg, instrument, expiryCode, oi: true, fromDate: from, toDate: session }).catch(error => {
        if (/429/.test(String(error?.message))) chartsCooldownUntil = Date.now() + 20_000;
        console.warn(`dhan: daily candles ${held.symbol} ${expiry}: ${error?.message || error}`);
        return null;
      }),
      wantMinute
        ? post('/charts/intraday', { securityId: String(id), exchangeSegment: held.exchSeg, instrument, interval: 1, oi: true, fromDate: session, toDate: session }).catch(error => {
            if (/429/.test(String(error?.message))) chartsCooldownUntil = Date.now() + 20_000;
            console.warn(`dhan: minute candles ${held.symbol} ${expiry}: ${error?.message || error}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    let prevClose = null, prevOi = null, prevHigh = null, prevLow = null;
    if (daily?.timestamp?.length) {
      const stamps = daily.timestamp.map(Number);
      for (let i = stamps.length - 1; i >= 0; i--) {
        if (ymdIst(stamps[i] * 1000) < session) {
          prevClose = num(daily.close?.[i]);
          prevOi = num(daily.open_interest?.[i]);
          prevHigh = num(daily.high?.[i]);
          prevLow = num(daily.low?.[i]);
          break;
        }
      }
    }
    const stamps = (minute?.timestamp ?? []).map(Number);
    const candles = stamps
      .map((t, i) => {
        const candle = {
          at: t > 1e12 ? t : t * 1000,
          open: num(minute.open?.[i]),
          high: num(minute.high?.[i]),
          low: num(minute.low?.[i]),
          close: num(minute.close?.[i]),
          oi: num(minute.open_interest?.[i]),
        };
        const volume = num(minute.volume?.[i]);
        if (volume != null && volume >= 0) candle.volume = volume;
        return candle;
      })
      .filter(c => Number.isFinite(c.at) && c.close != null && c.close > 0 && Number.isFinite(c.oi))
      .sort((a, b) => a.at - b.at);
    return { prevClose, prevOi, prevHigh, prevLow, candles };
  }

  // ── Strike windows and the rebalancer ─────────────────────────────────────

  function nearestStrikes(list, spot, eachSide) {
    if (!list.length) return [];
    let at = 0, best = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(list[i] - spot);
      if (d < best) { best = d; at = i; }
    }
    return list.slice(Math.max(0, at - eachSide), at + eachSide + 1);
  }

  function buildWindows(session, nextEachSide = NEXT_EXPIRY_ENABLED ? NEXT_EXPIRY_STRIKES_EACH_SIDE : null) {
    const today = ymdIst(Date.now());
    const optionKeys = [], coreKeys = [];
    for (const held of map.values()) {
      coreKeys.push(`${SEG_BYTE[held.underSeg]}:${held.underlyingId}`);
      for (const f of held.fut.filter(f => f.expiry >= session).slice(0, FUTURES_MONTHS)) {
        coreKeys.push(`${SEG_BYTE[held.exchSeg]}:${f.id}`);
        if (!futTicks.has(f.id)) futTicks.set(f.id, new Map());
      }
      const near = held.expiries.find(e => e >= today);
      if (!near) continue;
      const strikes = held.optionStrikes?.ids;
      held.optionStrikes = { expiry: near, window: [], ids: strikes ?? new Map() };
      const ids = held.optionStrikes.ids;
      ids.clear();
      const perExpiry = held.strikeMap.get(near);
      for (const strike of held.strikeList?.get(near) ?? []) ids.set(strike, perExpiry?.get(strike) ?? {});
      if (!ids.size) continue;
      const spot = underlyingQuote(held)?.spot;
      if (!spot) continue;
      const listed = [...ids.keys()].sort((a, b) => a - b);
      held.optionStrikes.window = nearestStrikes(listed, spot, STRIKES_EACH_SIDE);
      for (const strike of held.optionStrikes.window) {
        const legs = ids.get(strike) ?? {};
        // Option legs live on the UNDERLYING's FNO segment: NSE options on
        // NSE_FNO, BSE options (Sensex, BSE-listed stocks) on BSE_FNO.
        const legSeg = SEG_BYTE[held.exchSeg] ?? SEG_BYTE.NSE_FNO;
        if (legs.CE) optionKeys.push(`${legSeg}:${legs.CE}`);
        if (legs.PE) optionKeys.push(`${legSeg}:${legs.PE}`);
      }
      held.optionStrikes.center = spot;
      // Second pass: the NEXT live expiry gets its own narrower window so the
      // advisor can build slow-decay cards when the near week is too close.
      held.nextWindow = null;
      if (!nextEachSide) continue;
      const nextExpiry = held.expiries.find(e => e > near);
      const perExpiryNext = nextExpiry ? held.strikeMap.get(nextExpiry) : null;
      if (!nextExpiry || !perExpiryNext?.size) continue;
      const listedNext = [...perExpiryNext.keys()].sort((a, b) => a - b);
      const windowNext = nearestStrikes(listedNext, spot, nextEachSide);
      held.nextWindow = { expiry: nextExpiry, ids: perExpiryNext, window: windowNext, center: spot, eachSide: nextEachSide };
      const nextLegSeg = SEG_BYTE[held.exchSeg] ?? SEG_BYTE.NSE_FNO;
      for (const strike of windowNext) {
        const legs = perExpiryNext.get(strike) ?? {};
        if (legs.CE) optionKeys.push(`${nextLegSeg}:${legs.CE}`);
        if (legs.PE) optionKeys.push(`${nextLegSeg}:${legs.PE}`);
      }
    }
    return { coreKeys, optionKeys };
  }

  async function rebalance() {
    const today = ymdIst(Date.now());
    let changed = false;
    const drops = [], adds = [];
    for (const held of map.values()) {
      if (!held.optionStrikes?.window?.length) continue;
      if (held.optionStrikes.expiry < today) { changed = true; continue; }
      const spot = underlyingQuote(held)?.spot;
      if (!spot || !held.optionStrikes.center) continue;
      if (Math.abs(spot - held.optionStrikes.center) / spot < 0.004) continue;
      const listed = [...held.optionStrikes.ids.keys()].sort((a, b) => a - b);
      const fresh = nearestStrikes(listed, spot, STRIKES_EACH_SIDE);
      const oldSet = new Set(held.optionStrikes.window);
      const newSet = new Set(fresh);
      for (const strike of oldSet) {
        if (newSet.has(strike)) continue;
        const legs = held.optionStrikes.ids.get(strike) ?? {};
        if (legs.CE) drops.push(`${SEG_BYTE.NSE_FNO}:${legs.CE}`);
        if (legs.PE) drops.push(`${SEG_BYTE.NSE_FNO}:${legs.PE}`);
      }
      for (const strike of fresh) {
        if (oldSet.has(strike)) continue;
        const legs = held.optionStrikes.ids.get(strike) ?? {};
        if (legs.CE) adds.push(`${SEG_BYTE.NSE_FNO}:${legs.CE}`);
        if (legs.PE) adds.push(`${SEG_BYTE.NSE_FNO}:${legs.PE}`);
      }
      held.optionStrikes.window = fresh;
      held.optionStrikes.center = spot;
      // Keep the December window in sync with the same centre-drift rule.
      if (held.nextWindow?.window?.length && held.nextWindow.expiry >= today) {
        const nSpot = underlyingQuote(held)?.spot;
        if (nSpot && held.nextWindow.center && Math.abs(nSpot - held.nextWindow.center) / nSpot >= 0.004) {
          const listedNext = [...held.nextWindow.ids.keys()].sort((a, b) => a - b);
          const freshNext = nearestStrikes(listedNext, nSpot, held.nextWindow.eachSide ?? NEXT_EXPIRY_STRIKES_EACH_SIDE);
          const oldNext = new Set(held.nextWindow.window);
          const newNext = new Set(freshNext);
          const nextLegSeg = SEG_BYTE[held.exchSeg] ?? SEG_BYTE.NSE_FNO;
          for (const strike of oldNext) {
            if (newNext.has(strike)) continue;
            const legs = held.nextWindow.ids.get(strike) ?? {};
            if (legs.CE) drops.push(`${nextLegSeg}:${legs.CE}`);
            if (legs.PE) drops.push(`${nextLegSeg}:${legs.PE}`);
          }
          for (const strike of freshNext) {
            if (oldNext.has(strike)) continue;
            const legs = held.nextWindow.ids.get(strike) ?? {};
            if (legs.CE) adds.push(`${nextLegSeg}:${legs.CE}`);
            if (legs.PE) adds.push(`${nextLegSeg}:${legs.PE}`);
          }
          held.nextWindow.window = freshNext;
          held.nextWindow.center = nSpot;
        }
      }
    }
    if (drops.length) unsubscribe(drops);
    if (adds.length) subscribe(adds, 'options');
    if (changed) console.warn('dhan: option expiry rolled over — restart the server to rebuild the instrument map (or it rebuilds on the next session).');
  }

  // ── The provider ──────────────────────────────────────────────────────────

  return {
    id: 'dhan',
    label: 'Dhan',

    async init() {
      if (!token || token === 'PUT-YOUR-TOKEN-HERE') throw new Error('Set DHAN_ACCESS_TOKEN (web.dhan.co → My Profile → DhanHQ Trading Access; see PROVIDERS.md).');
      if (!clientId || clientId === 'PUT-YOUR-CLIENT-ID-HERE') throw new Error('Set DHAN_CLIENT_ID (your Dhan client id, shown next to the avatar on web.dhan.co).');

      // Owner rule: refresh the scrip master on EVERY app start, before any
      // other boot job — new listings/expiries must never wait on a stale cache.
      // The cached copy is only a fallback when the download itself fails.
      let text = null;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(MASTER_CACHE).mtimeMs; } catch { /* no cache yet */ }
      try {
        const res = await fetch(MASTER, { headers: { 'User-Agent': 'Mozilla/5.0 (order-flow)' }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
        fs.mkdirSync(path.dirname(MASTER_CACHE), { recursive: true });
        fs.writeFileSync(MASTER_CACHE, text);
        console.log('dhan: scrip master refreshed at boot');
      } catch (error) {
        if (age < Infinity) {
          console.warn(`dhan: master download failed (${error?.message || error}); using the cached copy from ${Math.round(age / 3600_000)}h ago`);
          text = fs.readFileSync(MASTER_CACHE, 'utf8');
        } else {
          throw new Error(`Dhan instrument master unavailable: ${error?.message || error}`);
        }
      }

      const rows = csvRows(text);
      const header = rows.next().value ?? [];
      const col = name => header.indexOf(name);
      const C = { exch: col('SEM_EXM_EXCH_ID'), seg: col('SEM_SEGMENT'), id: col('SEM_SMST_SECURITY_ID'), instr: col('SEM_INSTRUMENT_NAME'), code: col('SEM_EXPIRY_CODE'), sym: col('SEM_TRADING_SYMBOL'), exp: col('SEM_EXPIRY_DATE'), strike: col('SEM_STRIKE_PRICE'), opt: col('SEM_OPTION_TYPE') };

      const indices = new Map(), equities = new Map(), fno = new Map();
      for (const row of rows) {
        const exch = row[C.exch], seg = row[C.seg], instr = row[C.instr];
        const id = Number(row[C.id]);
        const symbol = (row[C.sym] ?? '').toUpperCase();
        if (!symbol || !Number.isFinite(id)) continue;
        if (seg === 'I' && instr === 'INDEX') indices.set(symbol, { id, exch });
        else if (seg === 'E' && instr === 'EQUITY' && exch === 'NSE') equities.set(symbol, id);
        else if (seg === 'D' && symbol.endsWith('-FUT')) {
          const hyphen = symbol.lastIndexOf('-');
          const base = symbol.slice(0, symbol.lastIndexOf('-', hyphen - 1));
          const held = fno.get(`${exch}|${base}`) ?? { fut: [], expiries: new Set(), exchSeg: exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO', strikes: new Map(), strikeList: new Map() };
          held.fut.push({ id, expiry: ymd(row[C.exp]), expiryCode: Number(row[C.code]) || 0, instrument: instr });
          fno.set(`${exch}|${base}`, held);
        } else if (seg === 'D' && (row[C.opt] === 'CE' || row[C.opt] === 'PE')) {
          const hyphen = symbol.lastIndexOf('-');
          const strikeHyphen = symbol.lastIndexOf('-', hyphen - 1);
          const base = symbol.slice(0, symbol.lastIndexOf('-', strikeHyphen - 1));
          const strike = Number(row[C.strike]);
          const expiry = ymd(row[C.exp]);
          const held = fno.get(`${exch}|${base}`) ?? { fut: [], expiries: new Set(), exchSeg: exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO', strikes: new Map(), strikeList: new Map() };
          held.expiries.add(expiry);
          if (Number.isFinite(strike) && strike > 0) {
            const perExpiry = held.strikes.get(expiry) ?? new Map();
            const legs = perExpiry.get(strike) ?? {};
            legs[row[C.opt]] = id;
            perExpiry.set(strike, legs);
            held.strikes.set(expiry, perExpiry);
            const list = held.strikeList.get(expiry) ?? [];
            if (!list.includes(strike)) list.push(strike);
            held.strikeList.set(expiry, list);
          }
          fno.set(`${exch}|${base}`, held);
        }
      }

      for (const u of universe) {
        const indexRow = indices.get(INDEX_ALIAS[u.symbol] ?? u.symbol);
        const equityId = u.kind === 'stock' ? equities.get(EQUITY_ALIAS[u.symbol] ?? u.symbol) : undefined;
        const dhanName = INDEX_ALIAS[u.symbol] ?? EQUITY_ALIAS[u.symbol] ?? u.symbol;
        const grp = fno.get(`${u.exch}|${dhanName}`) ?? fno.get(`${u.exch}|${u.symbol}`);
        if (!indexRow && equityId == null) continue;
        map.set(u.symbol, {
          symbol: u.symbol,
          kind: u.kind,
          underlyingId: indexRow ? indexRow.id : equityId,
          underSeg: indexRow ? 'IDX_I' : 'NSE_EQ',
          exchSeg: grp?.exchSeg ?? (u.exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO'),
          fut: (grp?.fut ?? []).sort((a, b) => a.expiry.localeCompare(b.expiry)),
          expiries: [...(grp?.expiries ?? [])].sort(),
          strikeMap: grp?.strikes ?? new Map(),
          strikeList: grp?.strikeList ?? new Map(),
          optionStrikes: null,
        });
      }

      const missing = universe.filter(u => !map.has(u.symbol)).map(u => u.symbol);
      if (missing.length) console.warn(`dhan: no instruments for ${missing.length} symbols: ${missing.slice(0, 20).join(' ')}`);
      const noFuture = universe.filter(u => map.has(u.symbol) && !map.get(u.symbol).fut.length).map(u => u.symbol);
      if (noFuture.length) console.warn(`dhan: no futures in Dhan's master for ${noFuture.length} symbols: ${noFuture.slice(0, 20).join(' ')} (they board on spot moves only)`);

      // Seed spot for the strike windows with the single whole-universe quote request.
      await ensureQuotes();

      // Open the feed: conn 0 carries underlyings + futures; the rest carry option strikes.
      conns.length = 0;
      conns.push({ socket: null, subs: new Set(), queue: [], unsubQueue: [], holds: null, draining: false, reconnectTimer: null });
      for (let i = 1; i < 5; i++) conns.push({ socket: null, subs: new Set(), queue: [], unsubQueue: [], holds: new Set(), draining: false, reconnectTimer: null });

      const session = ymdIst(Date.now());
      let { coreKeys, optionKeys } = buildWindows(session);
      let nextEachSide = NEXT_EXPIRY_ENABLED ? NEXT_EXPIRY_STRIKES_EACH_SIDE : null;
      // Capacity guard: December trims ±7 → ±5 → ±3 to keep every connection
      // under Dhan's per-connection cap (5,000), and the total under the 5-conn
      // budget; if even ±3 busts it, December drops entirely and the near chain
      // is protected (a rejected subscribe would silently lose instruments).
      const optionCap = (conns.length - 1) * 5_000;
      if (nextEachSide != null && (optionKeys.length > optionCap || coreKeys.length + optionKeys.length > FEED_INSTRUMENT_CAP)) {
        for (const candidate of [5, 3]) {
          ({ coreKeys, optionKeys } = buildWindows(session, candidate));
          nextEachSide = candidate;
          if (optionKeys.length <= optionCap && coreKeys.length + optionKeys.length <= FEED_INSTRUMENT_CAP) break;
        }
        if (optionKeys.length > optionCap || coreKeys.length + optionKeys.length > FEED_INSTRUMENT_CAP) {
          ({ coreKeys, optionKeys } = buildWindows(session, null));
          nextEachSide = null;
          console.warn(`dhan: instrument budget busts the caps even at ±3 (option cap ${optionCap}) — December capture disabled, near chain protected`);
        } else {
          console.warn(`dhan: December window trimmed to ±${nextEachSide} to fit the per-connection cap of 5,000`);
        }
      }
      let nextLegCount = 0;
      for (const held of map.values()) if (held.nextWindow?.window?.length) nextLegCount += held.nextWindow.window.length * 2;
      feedWant = new Set([...coreKeys, ...optionKeys]);
      conns[0].holds = new Set(coreKeys);
      for (let i = 1; i < conns.length; i++) {
        conns[i].holds = new Set(optionKeys.filter((_, j) => j % (conns.length - 1) === i - 1));
      }
      console.log(`dhan: feed want ${feedWant.size} instruments (core ${coreKeys.length}, near ${optionKeys.length - nextLegCount}, next ${nextLegCount}); holds ${conns.map(c => c.holds.size).join('/')}`);
      for (let i = 0; i < conns.length; i++) {
        // Stagger the connections: underlyings + futures land first, the option
        // subscriptions follow a second apart, so the first build has the core.
        if (i) await sleep(1000);
        await openConn(i);
      }

      if (rebalanceTimer) clearInterval(rebalanceTimer);
      rebalanceTimer = setInterval(() => {
        // Market closed → the spot is frozen and nothing can rebalance into a
        // new strike window: every one of these would be a wasted REST call
        // against a closed market.
        if (!isMarketSessionTime(Date.now())) return;
        // Indices are not broadcast on the feed: one quote request a minute keeps
        // their spot (and every underlying's prevClose backup) current.
        ensureQuotes().catch(() => undefined);
        rebalance().catch(() => undefined);
      }, 60_000);
      // Prev-day seed: fills previous-day OI (and IV/delta) for every subscribed
      // strike, which the board needs for "positions opened with the move".
      // Instant prev-day OI/close from yesterday's last snapshot — the REST
      // seed loop that follows only tops up IV/delta and full-chain snapshots.
      const diskSeeded = seedPrevDayFromDisk(session);
      if (!diskSeeded) console.warn('dhan: no prior-session snapshot on disk — falling back to the full REST seed');
      runSeedLoop().catch(() => undefined);
      // Watchdog, per connection: a half-open socket keeps readyState OPEN
      // while receiving nothing. Any connection silent for 45 s (or one that
      // never received anything a minute after opening) is force-closed so its
      // onclose handler reconnects it.
      if (watchdogTimer) clearInterval(watchdogTimer);
      // Resource ledger: one plain line every 5 minutes — REST calls, WS
      // packets/bytes, heap. The owner reads usage jumps from this log.
      const usageTimer = setInterval(usageTick, 5 * 60_000);
      usageTimer.unref();
      usageTick();
      watchdogTimer = setInterval(() => {
        const now = Date.now();
        for (let i = 0; i < conns.length; i++) {
          const conn = conns[i];
          if (conn.socket?.readyState !== 1) continue;
          const silent = conn.lastPacketAt ? now - conn.lastPacketAt > 45_000 : now - (conn.openedAt ?? now) > 60_000;
          if (silent) {
            console.warn(`dhan: feed ${i} silent for ${conn.lastPacketAt ? Math.round((now - conn.lastPacketAt) / 1000) : '60+'}s (${conn.packets ?? 0} packets so far) — forcing reconnect`);
            try { conn.socket.close(); } catch { /* already closing */ }
          }
        }
        if (process.env.DHAN_DEBUG) {
          const sensexHeld = map.get('SENSEX');
          const sensexIds = sensexHeld?.optionStrikes?.ids ?? new Map();
          const sample = [...sensexIds.keys()].slice(0, 2).map(strike => `${SEG_BYTE.BSE_FNO}:${sensexIds.get(strike)?.CE ?? '?'}`).join(', ');
          console.log(`dhan: dbg conns ${conns.map(c => `${c.packets ?? 0}pkt/${c.socket?.readyState}`).join(' ')} | sensex optionStrikes expiry=${sensexHeld?.optionStrikes?.expiry} window=${sensexHeld?.optionStrikes?.window?.length ?? 0} sample=[${sample}] | inWant=${feedWant.has(`8:${sensexIds.get(25100)?.PE ?? '?'}`)}`);
        }
      }, 30_000);
    },

    async expiries(u) {
      return entry(u.symbol).expiries;
    },

    getUsage() {
      // No logging here — /api/status is polled; the 5-minute tick owns the log line.
      return { restCalls: usage.restCalls, rest429: usage.rest429, packets: usage.packets, packetMb: Math.round(usage.packetBytes / 1_048_576), heapMb: usage.lastHeapMb, peakHeapMb: usage.peakHeapMb, since: usage.startedAt };
    },

    async optionChain(u, expiry) {
      const held = entry(u.symbol);
      // After the session (feed quiet for a minute), serve the last good chain:
      // nothing changes at close, and re-fetching 215 chains over the paced REST
      // path turns every build into an eleven-minute crawl.
      if (feedStartedAt > 0 && Date.now() - (feedHealthyAt || 0) > 60_000) {
        const cached = lastChain.get(`${u.symbol}:${expiry}`);
        if (cached && cached.expiry === expiry && Date.now() - cached.at < 6 * 3_600_000) return cached.chain;
      }
      // Feed boot: connections open and ~14k subscriptions land over the first
      // half-minute. Waiting beats falling back to REST chain calls, which
      // Dhan answers with 429s when anything else has gone out recently.
      const booting = feedHealthyAt === 0
        || conns.some(c => !c.socket || c.socket.readyState !== 1)
        || conns.some(c => c.queue.length > 0);
      if (feedHealthy() || booting) {
        const deadline = Date.now() + (feedHealthyAt ? 6000 : 25_000);
        let chain = feedHealthy() ? liveChain(held, expiry) : null;
        for (;;) {
          if (chain && chain.strikes.filter(s => s.call || s.put).length >= 3) { if (chain.spot > 0) lastChain.set(`${u.symbol}:${expiry}`, { expiry, at: Date.now(), chain }); return chain; }
          if (Date.now() > deadline) break;
          await sleep(1500);
          chain = feedHealthy() ? liveChain(held, expiry) : null;
        }
        // Past the deadline, a sparse-but-real chain still boards (the next
        // build, a minute later, is full). During the first three minutes the
        // feed is still filling in, so a bare chain retries rather than falling
        // to REST chain calls, which Dhan answers with 429s.
        if (chain && chain.strikes.filter(s => s.call || s.put).length >= 1) { if (chain.spot > 0) lastChain.set(`${u.symbol}:${expiry}`, { expiry, at: Date.now(), chain }); return chain; }
        if (booting && Date.now() - (feedStartedAt || Date.now()) < 180_000) throw new Error('dhan: option feed warming up');
      }
      const rest = await restChain(u, expiry, held);
      if (rest.spot > 0 && rest.strikes.length >= 3) lastChain.set(`${u.symbol}:${expiry}`, { expiry, at: Date.now(), chain: rest });
      if (rest.strikes.length) {
        fullChains.set(`${u.symbol}:${rest.at}`, createFullOptionChainSnapshot(u.symbol, ymdIst(rest.at), rest));
      }
      return rest;
    },

    async futures(u, session) {
      const held = entry(u.symbol);
      const months = held.fut.filter(f => f.expiry >= session).slice(0, FUTURES_MONTHS);
      const today = ymdIst(Date.now());
      return Promise.all(months.map(async ({ id, expiry, expiryCode, instrument }, month) => {
        const key = `${SEG_BYTE[held.exchSeg]}:${id}`;
        const feed = live.get(key) ?? {};
        // Serve from the feed while it is alive (or went quiet less than a minute
        // ago); a dead feed falls back to REST so the board keeps moving.
        const feedLive = feedHealthy() || Date.now() - (feedHealthyAt || 0) < 60_000;
        const fromFeed = session === today && feedLive;
        if (!fromFeed) {
          const rest = await restFuturesMonth(id, held, expiry, expiryCode, instrument, session, month === 0);
          return { date: expiry, prevClose: rest.prevClose, prevOi: rest.prevOi, prevHigh: rest.prevHigh, prevLow: rest.prevLow, candles: rest.candles };
        }
        // One REST backfill per contract per session: yesterday's close and OI,
        // plus the minutes before the feed was subscribed, which its ticks then
        // extend. A backfill that failed (rate limit) is retried on a later
        // call — but not while the charts limiter is cooling down, so the
        // retries pace themselves instead of stampeding.
        const backfill = futRest.get(id);
        let backfillOk = true;
        if (backfill) backfillOk = await backfill.then(v => !!v, () => false);
        const cooling = Date.now() < chartsCooldownUntil;
        if (backfill && !backfillOk && !cooling) {
          futRest.delete(id);
          futRest.set(id, restFuturesMonth(id, held, expiry, expiryCode, instrument, session, true).catch(() => null));
        }
        const rest = await futRest.get(id);
        const merged = new Map((rest?.candles ?? []).map(c => [c.at, c]));
        for (const candle of candlesFromFeed(id)) {
          const base = merged.get(candle.at);
          // Field-merge: feed's close/oi are fresher, REST's OHLC is ground
          // truth when the feed joined mid-minute (its H/L would be partial).
          merged.set(candle.at, base
            ? {
                ...candle,
                open: base.open ?? candle.open,
                high: base.high != null ? Math.max(base.high, candle.high) : candle.high,
                low: base.low != null ? Math.min(base.low, candle.low) : candle.low,
                close: candle.close,
                oi: candle.oi,
                volume: candle.volume ?? base.volume,
              }
            : candle);
        }
        const candles = [...merged.values()].sort((a, b) => a.at - b.at);
        // A restart empties the in-memory per-minute ticks, so right after boot
        // this feed path would return only a candle or two ("Too few minutes").
        // Merge today's persisted futures file (complete earlier minutes) as the
        // base and let the fresh feed ticks overlay the live ones.
        let finalCandles = candles;
        let diskNear = null;
        if (candles.length < 30) {
          try {
            const disk = readFutures(path.join(ROOT, 'server', 'data', 'dhan'), session, u.symbol);
            diskNear = disk?.months?.find(item => item?.date === expiry) ?? disk?.months?.[0] ?? null;
            if (Array.isArray(diskNear?.candles) && diskNear.candles.length > finalCandles.length) {
              const byAt = new Map(diskNear.candles.map(item => [item.at, item]));
              for (const item of finalCandles) {
                const base = byAt.get(item.at);
                byAt.set(item.at, base
                  ? {
                      ...base,
                      ...item,
                      open: base.open ?? item.open,
                      high: base.high != null ? Math.max(base.high, item.high) : item.high,
                      low: base.low != null ? Math.min(base.low, item.low) : item.low,
                      close: item.close,
                      oi: item.oi,
                      volume: item.volume ?? base.volume,
                    }
                  : item);
              }
              finalCandles = [...byAt.values()].sort((a, b) => a.at - b.at);
            }
          } catch { /* disk read is optional */ }
        }
        let prevClose = feed.prevClose ?? feed.close ?? rest?.prevClose ?? diskNear?.prevClose ?? null;
        let prevOi = feed.prevOi ?? rest?.prevOi ?? diskNear?.prevOi ?? null;
        // Previous-session high/low (PDH/PDL) feed the ORB scanner; they only
        // come from the daily-candle read, so a rate-limited backfill leaves
        // them null rather than inventing a level.
        const prevHigh = rest?.prevHigh ?? diskNear?.prevHigh ?? null;
        const prevLow = rest?.prevLow ?? diskNear?.prevLow ?? null;
        // The charts backfill (prev-day OI/close) can be rate-limited; fall back
        // to the previous session's persisted last candle so OI never goes blank.
        if (prevOi == null || prevClose == null) {
          const pd = prevDayFutures(u.symbol, session);
          if (pd) { prevClose = prevClose ?? pd.close; prevOi = prevOi ?? pd.oi; }
        }
        return { date: expiry, prevClose, prevOi, prevHigh, prevLow, candles: finalCandles };
      }));
    },

    // Tick-level spots straight from the feed's live readings — no REST, no
    // build cycle. Indices land via the 60s REST quote pass (Dhan's feed does
    // not broadcast index spots). Symbols without a usable reading are absent.
    spots() {
      const out = {};
      for (const held of map.values()) {
        const feed = live.get(`${SEG_BYTE[held.underSeg]}:${held.underlyingId}`);
        const q = quotes?.[held.underSeg]?.[String(held.underlyingId)];
        const ltp = feed?.ltp || num(q?.last_price) || null;
        const prevClose = feed?.prevClose || num(q?.ohlc?.close) || null;
        if (ltp != null && prevClose != null) out[held.symbol] = { ltp, prevClose, at: feed?.t ?? null };
      }
      return out;
    },

    // Full REST chains already obtained by the seed/fallback path. This does
    // not issue requests; the server drains persistence by snapshot timestamp.
    fullChainSnapshots() {
      return [...fullChains.values()];
    },

    // Live tick readings for named contracts: the nearest future per symbol
    // and specific option strikes (symbol|strike|side|expiry). Entries whose
    // contract is unknown or hasn't ticked yet are absent. Never throws.
    ticksFor({ symbols = [], options = [] } = {}) {
      const out = { futures: {}, options: {} };
      for (const symbol of Array.isArray(symbols) ? symbols : []) {
        const held = map.get(symbol);
        const fut = held?.fut?.[0];
        if (!fut) continue;
        const reading = live.get(`${SEG_BYTE[held.exchSeg]}:${fut.id}`);
        if (Number.isFinite(reading?.ltp) && reading.ltp > 0) out.futures[symbol] = { ltp: reading.ltp, at: reading.t ?? null };
      }
      for (const option of Array.isArray(options) ? options : []) {
        const held = map.get(option?.symbol);
        if (!held) continue;
        const expiry = held.expiries.includes(option.expiry) ? option.expiry : held.expiries[0];
        if (!expiry) continue;
        const id = held.strikeMap.get(expiry)?.get(option.strike)?.[option.side];
        if (!id) continue;
        const reading = live.get(`${SEG_BYTE[held.exchSeg]}:${id}`);
        if (Number.isFinite(reading?.ltp) && reading.ltp > 0) out.options[`${option.symbol}|${option.strike}|${option.side}|${expiry}`] = { ltp: reading.ltp, at: reading.t ?? null };
      }
      return out;
    },

    // Read-only feed health for /api/health: the sockets that should be open,
    // the packet counters, whether ticks still flow, and whether the
    // credentials sit in a 401 cooldown. Never throws, never calls REST.
    health() {
      const open = conns.filter(conn => conn.socket?.readyState === 1).length;
      const packets = conns.reduce((sum, conn) => sum + (conn.packets ?? 0), 0);
      const lastPacketAt = conns.reduce((latest, conn) => Math.max(latest, conn.lastPacketAt ?? 0), 0) || null;
      return {
        connections: { open, total: conns.length },
        healthy: conns.length > 0 && open === conns.length,
        flowing: feedHealthy(),
        packets,
        lastPacketAt,
        tokenState: Date.now() < authFailUntil ? 'rejected' : 'ok',
      };
    },
  };
}
