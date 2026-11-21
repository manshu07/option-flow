/**
 * ORB scanner model — the owner's opening-range playbook as pure functions.
 *
 * Playbook (docs/ORB_SCANNER_SPEC.md): the 09:15–09:20 first candle is the
 * opening range; from 09:20 participation (OI) must confirm; a breakout of the
 * range edge on the bias side is the trigger, the other edge is the stop zone;
 * a stock that opened ±4% or more is not chased — it waits for a VWAP touch.
 *
 * Everything here is a pure function of captured candles, so it is testable
 * with fixtures and never reads disk or the network.
 *
 * Kept separate from the December-expiry and observation-card work on purpose
 * (owner: "for ORB create something separated, don't combine everything").
 */

const MINUTE = 60_000;
const OPEN_OFFSET = 5; // the opening range is the first 5 minutes
const EXTENDED_PCT = 4; // a ±4% open is not chased (owner's 4–5% rule)
const OI_MIN_PCT = 5; // participation floor
const SOFT_OI_BEFORE = 9 * 60 + 30; // 09:30 IST — the gate is soft before this

export const ORB_STATES = ['building', 'armed', 'broken-out', 'extended-wait', 'entered-zone', 'done'];

/** Canonical symbol-to-sector projection shared by the ORB scanner and advisor. */
export function sectorMapFromUnderlyings(underlyings) {
  const sectors = new Map();
  for (const item of Array.isArray(underlyings) ? underlyings : []) {
    if (typeof item?.symbol === 'string' && item.symbol && typeof item.sector === 'string' && item.sector) {
      sectors.set(item.symbol, item.sector);
    }
  }
  return sectors;
}

export function sessionOpenAt(session) {
  const at = Date.parse(`${session}T09:15:00+05:30`);
  return Number.isFinite(at) ? at : null;
}

/** Minutes since the 09:15 open, IST — used for the soft/hard OI gate. */
export function sessionMinute(at, session) {
  const open = sessionOpenAt(session);
  if (open == null || !Number.isFinite(at)) return null;
  return Math.floor((at - open) / MINUTE) + 9 * 60 + 15;
}

const high = candle => (Number.isFinite(candle?.high) ? candle.high : candle?.close);
const low = candle => (Number.isFinite(candle?.low) ? candle.low : candle?.close);
const px = value => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);

/**
 * The 09:15–09:20 opening range. Null until the 09:20 candle exists, and null
 * when the window captured nothing at all. Fewer than 5 candles is normal for
 * illiquid futures (Dhan prints no candle in a minute with no trades), so the
 * range is built from whatever minutes the window does hold.
 */
export function openingRange(candles, session, { minutes = OPEN_OFFSET, now = Date.now() } = {}) {
  const open = sessionOpenAt(session);
  if (open == null) return null;
  if (Number.isFinite(now) && now < open + minutes * MINUTE) return null;
  const window = (candles ?? []).filter(candle => Number.isFinite(candle?.at) && candle.at >= open && candle.at < open + minutes * MINUTE);
  if (!window.length) return null;
  const hi = Math.max(...window.map(high));
  const lo = Math.min(...window.map(low));
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  const first = window[0];
  const last = window[window.length - 1];
  return {
    high: hi,
    low: lo,
    width: hi - lo,
    open: Number.isFinite(first?.open) ? first.open : first?.close ?? null,
    close: Number.isFinite(last?.close) ? last.close : null,
    candles: window.length,
  };
}

/**
 * Session VWAP from minute candles. Candles carry a `volume` only when the
 * source provides one (Dhan intraday does); with no volume this returns null
 * rather than inventing an average.
 */
export function sessionVwap(candles, session, { until = Infinity } = {}) {
  const open = sessionOpenAt(session);
  if (open == null) return null;
  let pv = 0;
  let vol = 0;
  for (const candle of candles ?? []) {
    if (!Number.isFinite(candle?.at) || candle.at < open || candle.at > until) continue;
    const volume = Number(candle.volume);
    const hi = high(candle);
    const lo = low(candle);
    const close = Number(candle.close);
    if (!(volume > 0) || !Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(close)) continue;
    pv += ((hi + lo + close) / 3) * volume;
    vol += volume;
  }
  return vol > 0 ? pv / vol : null;
}

/** PDH/PDL as carried by the futures snapshot's previous-session daily read. */
export function prevDayLevels(month) {
  const pdh = Number(month?.prevHigh);
  const pdl = Number(month?.prevLow);
  return { pdh: Number.isFinite(pdh) && pdh > 0 ? pdh : null, pdl: Number.isFinite(pdl) && pdl > 0 ? pdl : null };
}

/** OI change of the underlying future, previous-session close → latest minute ≤ now. */
export function futuresOiPct(month, now = Infinity) {
  const prevOi = Number(month?.prevOi);
  const candles = Array.isArray(month?.candles) ? month.candles : [];
  let lastOi = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (!Number.isFinite(candles[i]?.at) || candles[i].at + MINUTE > now) continue;
    if (Number.isFinite(candles[i]?.oi)) { lastOi = candles[i].oi; break; }
  }
  if (!(prevOi > 0) || !(lastOi > 0)) return null;
  return ((lastOi - prevOi) / prevOi) * 100;
}

/** Last captured close at or before `now`. */
export function lastPrice(candles, now = Date.now()) {
  let close = null;
  for (const candle of candles ?? []) {
    if (!Number.isFinite(candle?.at) || candle.at + MINUTE > now) continue;
    if (Number.isFinite(candle.close)) close = candle.close;
  }
  return close;
}

/**
 * The first candle at/after `from` whose range touches `level` — the "waited and
 * got the VWAP touch" evidence for an extended opener.
 */
export function touchAt(candles, level, { from = -Infinity, until = Date.now() } = {}) {
  if (!Number.isFinite(level)) return null;
  for (const candle of candles ?? []) {
    if (!Number.isFinite(candle?.at) || candle.at < from || candle.at + MINUTE > until) continue;
    if (low(candle) <= level && high(candle) >= level) return candle.at;
  }
  return null;
}

/**
 * Sector gate (S4). The morning's leading sectors come from the day's strongest
 * movers; a candidate agrees when its sector is one of them. Unknown sector or
 * no leading sectors = 'neutral', which never blocks.
 */
export function sectorGate(sector, leadingSectors) {
  if (typeof sector !== 'string' || !sector) return 'neutral';
  const leading = Array.isArray(leadingSectors) ? leadingSectors.filter(item => typeof item === 'string' && item) : [];
  if (!leading.length) return 'neutral';
  return leading.includes(sector) ? 'aligned' : 'against';
}

/**
 * Side OI change from the captured chain: the CE leg's OI for an upside break,
 * the PE leg's for a downside one. A down day unwinds futures OI, so futures
 * OI alone can never confirm a bearish breakout — the put side is where the
 * participation shows. Rows are [strike, side(0=CE,1=PE), ltp, prevClose, oi, prevOi, …].
 */
export function chainSideOi(rows) {
  const totals = { ce: { oi: 0, prevOi: 0 }, pe: { oi: 0, prevOi: 0 } };
  for (const row of rows ?? []) {
    if (!Array.isArray(row)) continue;
    const side = row[1] === 1 ? 'pe' : row[1] === 0 ? 'ce' : null;
    if (!side) continue;
    const oi = Number(row[4]);
    const prevOi = Number(row[5]);
    if (!(oi > 0) || !(prevOi > 0)) continue;
    totals[side].oi += oi;
    totals[side].prevOi += prevOi;
  }
  const pct = side => (totals[side].prevOi > 0 ? ((totals[side].oi - totals[side].prevOi) / totals[side].prevOi) * 100 : null);
  return { ce: pct('ce'), pe: pct('pe') };
}

const signed = value => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;

/**
 * One symbol's scanner row. Pure: candles + prevOi + sector in, state out.
 *
 * `state` walks building → armed → broken-out, with extended-wait / entered-zone
 * for a ±4% opener. `qualifies` is the push rule: a real breakout with OI ≥ 5%
 * from 09:30 (soft before), no extended chase, and no contradicting sector.
 */
export function orbRow({ symbol, session, now = Date.now(), candles = [], prevOi = null, prevHigh = null, prevLow = null, sector = null, leadingSectors = [], chainOi = null }) {
  const open = sessionOpenAt(session);
  const range = openingRange(candles, session, { now });
  const vwap = sessionVwap(candles, session, { until: now });
  const { pdh, pdl } = prevDayLevels({ prevHigh, prevLow });
  const price = lastPrice(candles, now);
  const futuresPct = futuresOiPct({ prevOi, candles }, now);
  const oiPct = futuresPct;
  const sectorState = sectorGate(sector, leadingSectors);
  const base = { symbol, session, at: now, price: px(price), oiPct: oiPct == null ? null : Number(oiPct.toFixed(1)), oiSource: oiPct == null ? null : 'future', vwap: px(vwap), pdh, pdl, sector, sectorState, qualifies: false, blockers: [] };

  if (open == null || !Number.isFinite(now) || now < open + OPEN_OFFSET * MINUTE) return { ...base, state: 'building', label: 'range not ready yet — needs the 09:20 candle', rangeHigh: null, rangeLow: null, openMovePct: null };
  if (!range) return { ...base, state: 'building', label: 'opening range not captured yet — no candle between 09:15 and 09:20', rangeHigh: null, rangeLow: null, openMovePct: null };

  const openMovePct = Number.isFinite(range.open) && range.open > 0 && Number.isFinite(range.close)
    ? ((range.close - range.open) / range.open) * 100
    : null;
  const ranges = { rangeHigh: px(range.high), rangeLow: px(range.low), openMovePct: openMovePct == null ? null : Number(openMovePct.toFixed(1)) };
  const extended = openMovePct != null && Math.abs(openMovePct) >= EXTENDED_PCT;
  const minute = sessionMinute(now, session);
  const oiHard = minute != null && minute >= SOFT_OI_BEFORE;
  const confirmations = side => {
    const chain = chainOi?.[side];
    if (Number.isFinite(chain)) return { pct: chain, source: `chain-${side}` };
    return { pct: futuresPct, source: futuresPct == null ? null : 'future' };
  };
  const oiOkFor = value => !oiHard || (value != null && value >= OI_MIN_PCT);
  const blockersFor = (value, source) => {
    const out = [];
    if (!oiOkFor(value)) out.push(value == null ? 'OI change unknown' : `${source === 'future' ? 'future' : source === 'chain-pe' ? 'PE' : 'CE'} OI ${signed(value)} < 5%`);
    if (sectorState === 'against') out.push(`sector ${sector ?? 'unknown'} is not leading`);
    return out;
  };

  if (extended) {
    const confirm = confirmations(openMovePct != null && openMovePct < 0 ? 'pe' : 'ce');
    const blockers = blockersFor(confirm.pct, confirm.source);
    const touched = vwap != null && price != null ? touchAt(candles, vwap, { from: open + OPEN_OFFSET * MINUTE, until: now }) : null;
    if (touched) {
      const qualifies = oiOkFor(confirm.pct) && sectorState !== 'against';
      return { ...base, ...ranges, oiPct: confirm.pct == null ? null : Number(confirm.pct.toFixed(1)), oiSource: confirm.source, state: 'entered-zone', vwapTouchedAt: touched, qualifies, blockers: qualifies ? [] : blockers, label: `opened ${signed(openMovePct)} — VWAP ${px(vwap)} touched, ready to watch` };
    }
    return { ...base, ...ranges, oiPct: confirm.pct == null ? null : Number(confirm.pct.toFixed(1)), oiSource: confirm.source, state: 'extended-wait', qualifies: false, blockers, label: `opened ${signed(openMovePct)} — not chased, wait for a VWAP touch${vwap == null ? ' (VWAP needs volume)' : ` near ${px(vwap)}`}` };
  }

  // The break direction is where price went, not where the first five minutes
  // opened: on a down day a stock below its opening range is a downside break.
  const brokeUp = price != null && price > range.high;
  const brokeDown = price != null && price < range.low;
  if (!brokeUp && !brokeDown) {
    return { ...base, ...ranges, state: 'armed', qualifies: false, blockers: blockersFor(oiPct, 'future'), label: `inside the range ${px(range.low)}–${px(range.high)}, no breakout yet` };
  }
  const bullish = brokeUp;
  const confirm = confirmations(bullish ? 'ce' : 'pe');
  const blockers = blockersFor(confirm.pct, confirm.source);
  const level = bullish ? range.high : range.low;
  const stopZone = bullish ? range.low : range.high;
  const qualifies = oiOkFor(confirm.pct) && sectorState !== 'against';
  return {
    ...base,
    ...ranges,
    oiPct: confirm.pct == null ? null : Number(confirm.pct.toFixed(1)),
    oiSource: confirm.source,
    state: 'broken-out',
    direction: bullish ? 'up' : 'down',
    brokeLevel: px(level),
    stopZone: px(stopZone),
    qualifies,
    blockers: qualifies ? [] : blockers,
    label: `broke ${px(level)} ${bullish ? 'up' : 'down'} · ${confirm.source === 'future' ? 'future' : confirm.source === 'chain-pe' ? 'PE' : 'CE'} OI ${confirm.pct == null ? 'unknown' : signed(confirm.pct)} · stop zone ${px(stopZone)}`,
  };
}

/**
 * The two daily pushes (09:35 and 10:05 IST). One message each; when nothing
 * qualifies it says so once per slot in plain English. No trade prescriptions —
 * levels only.
 */
export function orbMessage(rows, { slot, date, footer = '' } = {}) {
  const title = slot === '10:05' ? '🚀 ORB 10:05' : '🚀 ORB 09:35';
  const live = (rows ?? []).filter(row => row && row.state !== 'building');
  const breakouts = live.filter(row => row.qualifies);
  const extended = live.filter(row => row.state === 'extended-wait');
  const lines = [`<b>${title}</b> · ${date ?? ''}`.trim()];
  if (!breakouts.length) {
    lines.push('No qualified breakouts today. Wait for the next opening range rather than forcing a trade.');
  } else {
    lines.push('<b>Breakouts</b> (range broken, OI confirming)');
    for (const row of breakouts.slice(0, 12)) {
      const range = row.rangeLow != null && row.rangeHigh != null ? `, range ${row.rangeLow}–${row.rangeHigh}` : '';
      const side = row.oiSource === 'chain-pe' ? 'PE OI' : row.oiSource === 'chain-ce' ? 'CE OI' : 'OI';
      lines.push(`• ${row.symbol} ${row.price ?? ''} — broke ${row.brokeLevel ?? ''} ${row.direction ?? ''}, ${side} ${row.oiPct == null ? 'unknown' : signed(row.oiPct)}${range}`.replace(/\s+,/g, ','));
    }
  }
  if (extended.length) {
    lines.push('<b>Extended openers</b> (do not chase — wait for a VWAP touch)');
    for (const row of extended.slice(0, 8)) lines.push(`• ${row.symbol} ${row.price ?? ''} — opened ${row.openMovePct == null ? 'up strongly' : signed(row.openMovePct)}${row.vwap == null ? '' : `, VWAP ${row.vwap}`}`);
  }
  const blocked = live.filter(row => row.state === 'broken-out' && !row.qualifies && row.blockers?.length).slice(0, 5);
  if (blocked.length) {
    lines.push('<b>Broke but not confirmed</b>');
    for (const row of blocked) lines.push(`• ${row.symbol} — ${row.blockers.join(', ')}`);
  }
  lines.push('Stop reference: the opposite edge of the 09:15–09:20 range. These are levels, not trade advice.');
  if (footer) lines.push(footer);
  return lines.join('\n');
}
