import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay, marketParts } from '../src/lib/marketSession.ts';

// ws-allow: one temporary C0 MCX OI measurement connection; never imported by production code.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_PATH = path.join(ROOT, 'docs', 'mcx-spike-contracts.json');
const OUTPUT_PATH = '/tmp/mcx-ticks.json';
const SEGMENT = 'MCX_COMM';
const SEGMENT_BYTE = 5;
const SUBSCRIBE_FULL = 21;
const CAPTURE_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;
const PACKET_SIZE = { 2: 16, 3: 112, 4: 50, 5: 12, 6: 16, 7: 8, 8: 162, 50: 10 };
const EXPECTED_SYMBOLS = ['GOLD', 'SILVER', 'NATURALGAS', 'GOLDM', 'SILVERM', 'NATURALGASM'];

function redact(value) {
  let text = String(value ?? '');
  for (const secret of [process.env.DHAN_ACCESS_TOKEN, process.env.DHAN_CLIENT_ID]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function sessionMinute(now) { return marketParts(now).minuteOfDay; }

function loadInstruments() {
  const master = JSON.parse(fs.readFileSync(CONTRACTS_PATH, 'utf8'));
  return EXPECTED_SYMBOLS.map(symbol => {
    const row = master.contracts?.find(item => item.root === symbol && item.nearFuture?.securityId);
    if (!row) throw new Error(`Missing futures securityId for ${symbol} in docs/mcx-spike-contracts.json`);
    return { symbol, securityId: String(row.nearFuture.securityId), expiry: row.nearFuture.expiry };
  });
}

function parsePacketBuffer(buffer, byId, stats, rawTicks, receivedAt) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const code = buffer.readUInt8(offset);
    const known = PACKET_SIZE[code];
    const declared = buffer.readUInt16LE(offset + 1);
    const size = known ?? (declared > 8 && declared <= buffer.length - offset ? declared : 0);
    if (!size || offset + size > buffer.length) break;

    const segment = buffer.readUInt8(offset + 3);
    const securityId = String(buffer.readUInt32LE(offset + 4));
    if (segment === SEGMENT_BYTE && byId.has(securityId)) {
      const stat = stats.get(securityId);
      let ltp = null;
      let oi = null;
      let volume = null;
      if (code === 2 || code === 4 || code === 8) {
        const value = buffer.readFloatLE(offset + 8);
        if (Number.isFinite(value) && value > 0) ltp = value;
      }
      if (code === 4 && size >= 16) volume = buffer.readUInt32LE(offset + 12);
      if (code === 5 && size >= 12) oi = buffer.readUInt32LE(offset + 8);
      if (code === 8 && size >= 38) {
        volume = buffer.readUInt32LE(offset + 22);
        oi = buffer.readUInt32LE(offset + 34);
      }
      if (ltp != null || oi != null || volume != null) stat.tickCount++;
      if (ltp != null) {
        stat.ltpTickCount++;
        if (stat.previousLtp !== ltp) stat.ltpChanges++;
        stat.previousLtp = ltp;
      }
      if (oi != null) {
        stat.oiPacketCount++;
        stat.oiFieldPresent = true;
        stat.oiValues.push(oi);
      }
      if (volume != null) stat.volumeSample = volume;
      if (ltp != null || oi != null || volume != null) {
        rawTicks.push({ receivedAt, symbol: stat.symbol, securityId, code, ltp, oi, volume, packetBase64: buffer.subarray(offset, offset + size).toString('base64') });
      }
    }
    offset += size;
  }
}

async function run() {
  const started = Date.now();
  const time = new Date(started);
  const minute = sessionMinute(started);
  if (!isTradingDay(started, 'MCX') || minute < 17 * 60 || minute >= 23 * 60 + 30) {
    throw new Error('C0 capture only runs in the weekday MCX evening window 17:00–23:30 IST');
  }
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  const clientId = process.env.DHAN_CLIENT_ID;
  if (!accessToken || !clientId) throw new Error('DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID are required in the process environment');
  if (typeof WebSocket === 'undefined') throw new Error('Node WebSocket global is unavailable');

  const instruments = loadInstruments();
  const byId = new Map(instruments.map(item => [item.securityId, item.symbol]));
  const stats = new Map(instruments.map(item => [item.securityId, {
    symbol: item.symbol, securityId: item.securityId, expiry: item.expiry,
    tickCount: 0, ltpTickCount: 0, ltpChanges: 0, previousLtp: null,
    oiPacketCount: 0, oiFieldPresent: false, oiValues: [], volumeSample: null,
  }]));
  const rawTicks = [];
  const socketUrl = `wss://api-feed.dhan.co?version=2&token=${encodeURIComponent(accessToken)}&clientId=${encodeURIComponent(clientId)}&authType=2`;
  const socket = new WebSocket(socketUrl);
  socket.binaryType = 'arraybuffer';
  let openedAt = null;
  let completed = false;
  let socketError = null;
  let connectTimer;
  let captureTimer;

  const capture = new Promise((resolve, reject) => {
    connectTimer = setTimeout(() => reject(new Error('C0 websocket did not open within 30 seconds')), CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(connectTimer);
      openedAt = new Date();
      const list = instruments.map(item => ({ ExchangeSegment: SEGMENT, SecurityId: item.securityId }));
      socket.send(JSON.stringify({ RequestCode: SUBSCRIBE_FULL, InstrumentCount: list.length, InstrumentList: list }));
      captureTimer = setTimeout(() => { completed = true; resolve(); }, CAPTURE_MS);
    };
    socket.onmessage = event => {
      if (typeof event.data === 'string') return;
      parsePacketBuffer(Buffer.from(new Uint8Array(event.data)), byId, stats, rawTicks, new Date().toISOString());
    };
    socket.onerror = event => { socketError = redact(event?.message || 'websocket error'); };
    socket.onclose = event => {
      clearTimeout(captureTimer);
      if (openedAt) resolve();
      else reject(new Error(`C0 websocket closed before opening (${event?.code ?? 'no close code'})`));
    };
  });

  let captureError = null;
  try { await capture; }
  catch (error) { captureError = redact(error?.message || error); }
  finally {
    clearTimeout(connectTimer);
    clearTimeout(captureTimer);
    try { socket.close(); } catch { /* already closed */ }
  }

  const endedAt = Date.now();
  const elapsedSeconds = openedAt ? (endedAt - openedAt.getTime()) / 1000 : 0;
  if (openedAt && !completed && !captureError) captureError = 'WebSocket closed before the requested 10-minute capture completed';
  const symbols = [...stats.values()].map(stat => ({
    symbol: stat.symbol,
    securityId: stat.securityId,
    expiry: stat.expiry,
    tickCount: stat.tickCount,
    ltpTickCount: stat.ltpTickCount,
    ltpChanges: stat.ltpChanges,
    ltpChangesPerSecond: elapsedSeconds > 0 ? stat.ltpChanges / elapsedSeconds : null,
    oiPacketCount: stat.oiPacketCount,
    oiFieldPresent: stat.oiFieldPresent,
    oiSample: stat.oiValues.at(-1) ?? null,
    oiDistinctValues: new Set(stat.oiValues).size,
    oiValuesChanging: new Set(stat.oiValues).size > 1,
    volumeSample: stat.volumeSample,
  }));
  const evidence = {
    startedAtIST: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium' }).format(time),
    startedAt: openedAt?.toISOString() ?? null,
    endedAt: new Date(endedAt).toISOString(),
    requestedSeconds: CAPTURE_MS / 1000,
    elapsedSeconds,
    exchangeSegment: SEGMENT,
    subscriptionRequestCode: SUBSCRIBE_FULL,
    instruments,
    status: captureError ? 'failed' : 'complete',
    captureError,
    socketError,
    allSymbolsHaveOi: symbols.length === 6 && symbols.every(item => item.oiFieldPresent),
    symbols,
    rawTicks,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ...evidence, rawTicks: `omitted from console; ${rawTicks.length} packets saved to ${OUTPUT_PATH}` }, null, 2));
  if (captureError) process.exitCode = 1;
  if (!evidence.allSymbolsHaveOi) process.exitCode = 2;
}

run().catch(error => {
  const evidence = { status: 'failed', atIST: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()), error: redact(error?.message || error) };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
});
