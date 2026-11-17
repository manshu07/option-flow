import fs from 'node:fs';
import path from 'node:path';

const SYMBOL = /^[A-Z0-9&._-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

function restLeg(side) {
  if (!side || typeof side !== 'object') return undefined;
  const g = side.greeks ?? {};
  const ltp = num(side.last_price) ?? 0;
  return {
    ltp,
    prevClose: num(side.previous_close_price),
    oi: num(side.oi) ?? 0,
    prevOi: num(side.previous_oi),
    volume: num(side.volume) ?? 0,
    prevVolume: num(side.previous_volume),
    avgPrice: num(side.average_price) ?? ltp,
    iv: num(side.implied_volatility),
    bid: num(side.top_bid_price) ?? 0,
    ask: num(side.top_ask_price) ?? 0,
    bidQty: num(side.top_bid_quantity) ?? 0,
    askQty: num(side.top_ask_quantity) ?? 0,
    dayHigh: null,
    dayLow: null,
    lastTradeAt: null,
    delta: num(g.delta),
  };
}

/** Normalize the full `oc` object returned by an existing Dhan option-chain call. */
export function normalizeDhanOptionChain(data, { expiry, at, spotFallback = null, prevClose = null }) {
  let spot = num(data?.last_price);
  if (!spot && spotFallback) spot = num(spotFallback);
  const strikes = Object.entries(data?.oc ?? {})
    .map(([key, sides]) => ({
      strike: Number(key),
      call: restLeg(sides?.ce),
      put: restLeg(sides?.pe),
    }))
    .filter(row => Number.isFinite(row.strike))
    .sort((a, b) => a.strike - b.strike);
  return { expiry, at, spot: spot ?? 0, prevClose, atm: null, strikes };
}

export function createFullOptionChainSnapshot(symbol, session, chain) {
  return {
    schemaVersion: 1,
    symbol,
    session,
    capturedAt: chain.at,
    expiry: chain.expiry,
    spot: chain.spot,
    prevClose: chain.prevClose,
    atm: chain.atm,
    strikes: chain.strikes,
  };
}

export function isFullOptionChainSnapshot(snapshot, symbol, session) {
  return Boolean(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && snapshot.schemaVersion === 1
    && snapshot.symbol === symbol && SYMBOL.test(symbol)
    && snapshot.session === session && validDate(session)
    && Number.isSafeInteger(snapshot.capturedAt)
    && validDate(snapshot.expiry)
    && Number.isFinite(snapshot.spot) && snapshot.spot >= 0
    && (snapshot.prevClose == null || Number.isFinite(snapshot.prevClose))
    && Array.isArray(snapshot.strikes)
    && snapshot.strikes.every(row => row && typeof row === 'object' && Number.isFinite(row.strike) && row.strike > 0
      && ['call', 'put'].every(side => row[side] == null || (typeof row[side] === 'object'
        && Number.isFinite(row[side].ltp) && Number.isFinite(row[side].oi)))));
}

export function isFullOptionChainSnapshotCollection(collection, symbol, session) {
  return Boolean(collection && typeof collection === 'object' && !Array.isArray(collection)
    && collection.schemaVersion === 1
    && collection.symbol === symbol && collection.session === session
    && validDate(session)
    && Array.isArray(collection.snapshots) && collection.snapshots.length > 0
    && collection.snapshots.every(snapshot => isFullOptionChainSnapshot(snapshot, symbol, session)));
}

/** Append every full-chain response to one per-symbol, per-session file. */
export function persistFullOptionChainSnapshots(scanDir, snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    if (!isFullOptionChainSnapshot(snapshot, snapshot?.symbol, snapshot?.session)) continue;
    const key = `${snapshot.session}:${snapshot.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(snapshot);
  }

  let written = 0;
  for (const captures of groups.values()) {
    const { symbol, session } = captures[0];
    const dir = path.join(scanDir, session, 'chains');
    const file = path.join(dir, `${symbol}.json`);
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (previous && !isFullOptionChainSnapshotCollection(previous, symbol, session)) throw new Error(`Existing chain snapshot file is invalid: ${file}`);

    const byTimestamp = new Map((previous?.snapshots ?? []).map(snapshot => [snapshot.capturedAt, snapshot]));
    for (const snapshot of captures) if (!byTimestamp.has(snapshot.capturedAt)) byTimestamp.set(snapshot.capturedAt, snapshot);
    const next = [...byTimestamp.values()].sort((a, b) => a.capturedAt - b.capturedAt);
    if (next.length === (previous?.snapshots.length ?? 0)) continue;

    fs.mkdirSync(dir, { recursive: true });
    const collection = { schemaVersion: 1, symbol, session, snapshots: next };
    const temporary = path.join(dir, `.${symbol}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(collection));
      fs.renameSync(temporary, file);
      written += next.length - (previous?.snapshots.length ?? 0);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
  return written;
}
