import { isTradingDay, marketCloseMinuteFor, marketParts } from '../src/lib/marketSession.ts';

const OPEN_MINUTE = 9 * 60 + 15;
const MINUTE_MS = 60_000;

function hhmm(at) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  return hour && minute ? `${hour}${minute}` : null;
}

export function rowForCard(card, snapshot) {
  const series = snapshot?.series?.find(item => item?.s === card.symbol);
  const side = card.side === 'CE' ? 0 : 1;
  // Keep journal.mjs contract routing verbatim: use next rows only when the
  // card expiry equals series.next.e, otherwise use the near rows.
  const rows = typeof card.expiry === 'string' && series?.next?.e === card.expiry ? series.next.r : series?.r;
  return rows?.find(row => Array.isArray(row) && row[0] === card.strike && row[1] === side) ?? null;
}

function pointFor(card, snapshot, source) {
  if (!snapshot || typeof snapshot.date !== 'string' || !Number.isFinite(snapshot.t)) return null;
  const series = snapshot.series?.find(item => item?.s === card.symbol);
  const row = rowForCard(card, { series: series ? [series] : [] });
  const at = Number.isFinite(series?.t) ? series.t : snapshot.t;
  if (!row || !Number.isFinite(row[2]) || row[2] <= 0 || !Number.isFinite(at)) return null;
  try { if (marketParts(at).dateKey !== snapshot.date) return null; }
  catch { return null; }
  return {
    at,
    date: snapshot.date,
    price: row[2],
    dayHigh: Math.max(row[2], Number.isFinite(row[14]) && row[14] > 0 ? row[14] : row[2]),
    dayLow: Math.min(row[2], Number.isFinite(row[15]) && row[15] > 0 ? row[15] : row[2]),
    source,
  };
}

function minuteKey(snapshot) {
  return Number.isFinite(snapshot?.t) ? hhmm(snapshot.t) : null;
}

function expectedMinutesFor(card, dates) {
  return dates.reduce((total, date) => {
    const noon = Date.parse(`${date}T12:00:00+05:30`);
    if (!Number.isFinite(noon)) return total;
    const close = marketCloseMinuteFor(noon);
    let first = OPEN_MINUTE;
    if (date === card.date && Number.isFinite(card.at)) {
      try { first = Math.max(OPEN_MINUTE, marketParts(card.at).minuteOfDay); }
      catch { first = OPEN_MINUTE; }
    }
    return total + Math.max(0, close - first + 1);
  }, 0);
}

/** Collect only matching contract samples; gzip snapshots are consumed one at a time. */
export async function extractContractTimelines(cards, datesForCard, {
  readRawIndex,
  readRawMinute,
  readArchiveMinutes,
}) {
  const timelines = cards.map(() => new Map());
  const cardsByDate = new Map();
  const datesPerCard = cards.map((card, index) => {
    const dates = datesForCard(card);
    for (const date of dates) {
      if (!cardsByDate.has(date)) cardsByDate.set(date, []);
      cardsByDate.get(date).push(index);
    }
    return dates;
  });
  const counts = cards.map(() => ({ raw: 0, archive: 0 }));

  for (const date of [...cardsByDate.keys()].sort()) {
    const indexes = cardsByDate.get(date);
    const rawIndex = await readRawIndex(date);
    for (const value of Array.isArray(rawIndex) ? rawIndex : []) {
      const minute = String(Array.isArray(value) ? value[0] : value).padStart(4, '0');
      const snapshot = await readRawMinute(date, minute);
      if (!snapshot || snapshot.date !== date) continue;
      for (const index of indexes) {
        const point = pointFor(cards[index], snapshot, 'raw');
        if (!point) continue;
        timelines[index].set(`${date}:${minute}`, point);
        counts[index].raw++;
      }
    }

    const archive = await readArchiveMinutes(date);
    if (!archive) continue;
    for await (const snapshot of archive) {
      if (snapshot?.date !== date) continue;
      const minute = minuteKey(snapshot);
      if (!minute) continue;
      const key = `${date}:${minute}`;
      for (const index of indexes) {
        if (timelines[index].has(key)) continue;
        const point = pointFor(cards[index], snapshot, 'archive');
        if (!point) continue;
        timelines[index].set(key, point);
        counts[index].archive++;
      }
    }
  }

  return cards.map((card, index) => {
    const points = [...timelines[index].values()].sort((a, b) => a.at - b.at);
    const postEntry = points.filter(point => point.at >= card.at);
    const sampledMinutes = new Set(postEntry.map(point => `${point.date}:${minuteKey({ t: point.at })}`)).size;
    const expectedMinutes = expectedMinutesFor(card, datesPerCard[index]);
    return {
      card,
      points,
      sampledMinutes,
      expectedMinutes,
      missingMinutes: Math.max(0, expectedMinutes - sampledMinutes),
      rawSamples: counts[index].raw,
      archiveSamples: counts[index].archive,
    };
  });
}

function validFuturesSnapshot(snapshot, symbol, date) {
  return Boolean(snapshot && snapshot.symbol === symbol && snapshot.session === date
    && Array.isArray(snapshot.months) && Array.isArray(snapshot.months[0]?.candles));
}

function expectedFullFuturesCandles(card, dates) {
  let count = 0;
  for (const date of dates) {
    const noon = Date.parse(`${date}T12:00:00+05:30`);
    if (!Number.isFinite(noon)) continue;
    const close = Date.parse(`${date}T${String(Math.floor(marketCloseMinuteFor(noon) / 60)).padStart(2, '0')}:${String(marketCloseMinuteFor(noon) % 60).padStart(2, '0')}:00+05:30`);
    const first = date === card.date
      ? Math.ceil(card.at / MINUTE_MS) * MINUTE_MS
      : Date.parse(`${date}T09:15:00+05:30`);
    if (!Number.isFinite(first) || !Number.isFinite(close)) continue;
    count += Math.max(0, Math.floor((close - first) / MINUTE_MS));
  }
  return count;
}

/** Load the nearest stored futures month per symbol/day, raw first then streamed archive. */
export async function extractUnderlyingTimelines(cards, datesForCard, { readRawFutures, readArchiveFutures }) {
  const byDateSymbol = new Map();
  const datesPerCard = cards.map(card => datesForCard(card));
  const rowsPerCard = cards.map(() => []);
  const cardIndicesByDate = new Map();
  for (const [index, dates] of datesPerCard.entries()) {
    for (const date of dates) {
      if (!cardIndicesByDate.has(date)) cardIndicesByDate.set(date, new Map());
      const symbolMap = cardIndicesByDate.get(date);
      if (!symbolMap.has(cards[index].symbol)) symbolMap.set(cards[index].symbol, []);
      symbolMap.get(cards[index].symbol).push(index);
    }
  }

  for (const date of [...cardIndicesByDate.keys()].sort()) {
    const symbolMap = cardIndicesByDate.get(date);
    const missing = new Set();
    for (const symbol of symbolMap.keys()) {
      let snapshot = null;
      try { snapshot = await readRawFutures(date, symbol); } catch { /* archive can still supply this symbol */ }
      if (!validFuturesSnapshot(snapshot, symbol, date)) { missing.add(symbol); continue; }
      byDateSymbol.set(`${date}|${symbol}`, { snapshot, source: 'raw' });
    }
    if (missing.size && typeof readArchiveFutures === 'function') {
      const entries = await readArchiveFutures(date, missing);
      if (entries) {
        for await (const [symbol, snapshot] of entries) {
          if (!missing.has(symbol) || !validFuturesSnapshot(snapshot, symbol, date)) continue;
          byDateSymbol.set(`${date}|${symbol}`, { snapshot, source: 'archive' });
          missing.delete(symbol);
        }
      }
    }
  }

  for (const [index, card] of cards.entries()) {
    for (const date of datesPerCard[index]) {
      const stored = byDateSymbol.get(`${date}|${card.symbol}`);
      const candles = stored?.snapshot?.months?.[0]?.candles ?? [];
      const noon = Date.parse(`${date}T12:00:00+05:30`);
      const close = Number.isFinite(noon) ? Date.parse(`${date}T${String(Math.floor(marketCloseMinuteFor(noon) / 60)).padStart(2, '0')}:${String(marketCloseMinuteFor(noon) % 60).padStart(2, '0')}:00+05:30`) : null;
      const first = date === card.date ? Math.ceil(card.at / MINUTE_MS) * MINUTE_MS : Date.parse(`${date}T09:15:00+05:30`);
      for (const candle of candles) {
        if (!Number.isSafeInteger(candle?.at) || candle.at % MINUTE_MS !== 0
          || candle.at < first || close == null || candle.at + MINUTE_MS > close
          || !Number.isFinite(candle.close)) continue;
        rowsPerCard[index].push({ ...candle, date, source: stored.source });
      }
    }
    rowsPerCard[index].sort((a, b) => a.at - b.at);
  }

  return cards.map((card, index) => {
    const candles = rowsPerCard[index];
    const sampleKeys = new Set(candles.map(candle => `${candle.date}:${candle.at}`));
    const expectedCandles = expectedFullFuturesCandles(card, datesPerCard[index]);
    return {
      card,
      candles,
      expectedCandles,
      missingCandles: Math.max(0, expectedCandles - sampleKeys.size),
      rawCandles: candles.filter(candle => candle.source === 'raw').length,
      archiveCandles: candles.filter(candle => candle.source === 'archive').length,
    };
  });
}

/** Read-only S4 policy preview used by S2's ship/no-ship evidence table. */
export function simulateUnderlyingStopPreview(optionTimeline, futuresTimeline) {
  const card = optionTimeline.card;
  const slSpot = Number.isFinite(card.slSpot) ? card.slSpot : card.needs?.sl?.level;
  const baseRisk = Number.isFinite(card.entry) && Number.isFinite(card.sl) ? card.entry - card.sl : null;
  if (!(Number.isFinite(slSpot) && slSpot > 0 && baseRisk > 0 && Number.isFinite(card.tgt1) && card.tgt1 > card.entry)) {
    return { status: 'missing-level', r: null, hitAt: null, slTrigger: null, slSpot: Number.isFinite(slSpot) ? slSpot : null };
  }
  if (!Array.isArray(futuresTimeline?.candles) || futuresTimeline.candles.length === 0) {
    return { status: 'missing-futures', r: null, hitAt: null, slTrigger: null, slSpot };
  }

  const events = new Map();
  const add = (minuteAt, type) => {
    if (!events.has(minuteAt)) events.set(minuteAt, new Set());
    events.get(minuteAt).add(type);
  };
  const points = [...optionTimeline.points].sort((a, b) => a.at - b.at);
  let previousHigh = baselineExtremes(points, card).high;
  let previousLow = baselineExtremes(points, card).low;
  let activeDate = card.date;
  const hardStop = card.entry * 0.3;
  for (const point of points) {
    if (point.date < card.date) continue;
    if (point.date !== activeDate) { activeDate = point.date; previousHigh = null; previousLow = null; }
    const high = Math.max(point.price, point.dayHigh);
    const low = Math.min(point.price, point.dayLow);
    if (point.at >= card.at) {
      const premiumHit = point.price <= hardStop || (previousLow != null && previousLow > hardStop && low <= hardStop);
      const targetHit = point.price >= card.tgt1 || (previousHigh != null && previousHigh < card.tgt1 && high >= card.tgt1);
      const minuteAt = Math.floor(point.at / MINUTE_MS) * MINUTE_MS;
      if (premiumHit) add(minuteAt, 'premium');
      if (targetHit) add(minuteAt, 'target');
    }
    previousHigh = high;
    previousLow = low;
  }

  const firstFullMinute = Math.ceil(card.at / MINUTE_MS) * MINUTE_MS;
  for (const candle of futuresTimeline.candles) {
    const completedAt = candle.at + MINUTE_MS;
    if (candle.at < firstFullMinute || !Number.isFinite(candle.close)) continue;
    const breached = card.bias === 'bearish' ? candle.close >= slSpot : candle.close <= slSpot;
    if (breached) add(Math.floor(completedAt / MINUTE_MS) * MINUTE_MS, 'underlying');
  }

  for (const [minuteAt, types] of [...events.entries()].sort(([a], [b]) => a - b)) {
    const hasStop = types.has('underlying') || types.has('premium');
    const hasTarget = types.has('target');
    if (types.size > 1) return { status: 'ambiguous', r: -1, hitAt: minuteAt, slTrigger: null, slSpot };
    if (hasStop) {
      const slTrigger = types.has('underlying') ? 'underlying' : 'premium';
      return { status: 'sl', r: -1, hitAt: minuteAt, slTrigger, slSpot };
    }
    if (hasTarget) return { status: 'tgt1', r: +((card.tgt1 - card.entry) / baseRisk).toFixed(2), hitAt: minuteAt, slTrigger: null, slSpot };
  }
  return futuresTimeline.missingCandles > 0
    ? { status: 'censored', r: null, hitAt: null, slTrigger: null, slSpot }
    : { status: 'open', r: null, hitAt: null, slTrigger: null, slSpot };
}

function baselineExtremes(points, card) {
  const baseline = [...points].reverse().find(point => point.date === card.date && point.at <= card.at);
  return baseline
    ? { high: Math.max(baseline.price, baseline.dayHigh), low: Math.min(baseline.price, baseline.dayLow) }
    : { high: null, low: null };
}

function policyStop(card, policy, baseRisk) {
  if (policy.kind === 'scaled') return card.entry - policy.multiple * baseRisk;
  return card.sl;
}

/** Replay one policy by timestamp; the first captured touch settles the result. */
export function simulateStopVariant(timeline, policy) {
  const card = timeline.card;
  const points = [...(Array.isArray(timeline.points) ? timeline.points : [])].sort((a, b) => a.at - b.at);
  const baseRisk = Number.isFinite(card.entry) && Number.isFinite(card.sl) ? card.entry - card.sl : null;
  const stop = Number.isFinite(baseRisk) ? policyStop(card, policy, baseRisk) : null;
  const risk = Number.isFinite(stop) ? card.entry - stop : null;
  if (!(baseRisk > 0 && risk > 0 && Number.isFinite(card.tgt1) && card.tgt1 > card.entry)) {
    return { status: 'invalid', r: null, hitAt: null, stop, risk, preTargetDip: null, armedAt: null };
  }
  if (!points.some(point => point.at >= card.at)) {
    return { status: 'censored', r: null, hitAt: null, stop, risk, preTargetDip: null, armedAt: null };
  }

  const entryBaseline = baselineExtremes(points, card);
  let previousHigh = entryBaseline.high;
  let previousLow = entryBaseline.low;
  let activeDate = card.date;
  let activeStop = stop;
  let armedAt = null;
  let preTargetDip = 0;
  let last = null;
  const armLevel = policy.kind === 'breakeven' ? card.entry + policy.armR * baseRisk : null;

  for (const point of points) {
    if (point.date < card.date) continue;
    if (point.date !== activeDate) {
      activeDate = point.date;
      previousHigh = null;
      previousLow = null;
    }
    const high = Math.max(point.price, point.dayHigh);
    const low = Math.min(point.price, point.dayLow);
    if (point.at < card.at) {
      previousHigh = high;
      previousLow = low;
      continue;
    }
    last = point;

    const stopRangeHit = previousLow != null && previousLow > activeStop && low <= activeStop;
    const targetRangeHit = previousHigh != null && previousHigh < card.tgt1 && high >= card.tgt1;
    const stopHit = point.price <= activeStop || stopRangeHit;
    const targetHit = point.price >= card.tgt1 || targetRangeHit;
    const armHit = armLevel != null && (point.price >= armLevel
      || (previousHigh != null && previousHigh < armLevel && high >= armLevel));
    const armStopAmbiguous = policy.kind === 'breakeven' && armedAt == null && armHit
      && (stopHit || point.price <= card.entry || (previousLow != null && previousLow > card.entry && low <= card.entry));
    const newLow = previousLow != null && low < previousLow;
    const sampleDip = Math.min(preTargetDip, (newLow ? low : point.price) - card.entry);

    if (stopHit && targetHit || armStopAmbiguous) {
      return { status: 'ambiguous', r: -1, hitAt: point.at, stop: activeStop, risk, preTargetDip: +Math.max(0, -sampleDip).toFixed(2), armedAt };
    }
    if (stopHit) {
      const breakeven = policy.kind === 'breakeven' && armedAt != null && activeStop === card.entry;
      return { status: breakeven ? 'breakeven' : 'sl', r: breakeven ? 0 : -1, hitAt: point.at, stop: activeStop, risk, preTargetDip: +Math.max(0, -sampleDip).toFixed(2), armedAt };
    }
    if (targetHit) {
      return { status: 'tgt1', r: +((card.tgt1 - card.entry) / risk).toFixed(2), hitAt: point.at, stop: activeStop, risk, preTargetDip: +Math.max(0, -sampleDip).toFixed(2), armedAt };
    }
    if (policy.kind === 'breakeven' && armHit && armedAt == null) {
      activeStop = card.entry;
      armedAt = point.at;
    }

    preTargetDip = sampleDip;
    previousHigh = high;
    previousLow = low;
  }

  if (policy.closeExit && last) {
    return {
      status: 'close-exit',
      r: +((last.price - card.entry) / risk).toFixed(2),
      hitAt: last.at,
      stop: activeStop,
      risk,
      preTargetDip: +Math.max(0, -preTargetDip).toFixed(2),
      armedAt,
    };
  }
  return { status: 'open', r: null, hitAt: null, stop: activeStop, risk, preTargetDip: +Math.max(0, -preTargetDip).toFixed(2), armedAt };
}

export function expectedTradingDates(card) {
  const from = Date.parse(`${card.date}T00:00:00Z`);
  const untilDate = typeof card.holdTill === 'string' && card.holdTill >= card.date ? card.holdTill : card.date;
  const until = Date.parse(`${untilDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(until)) return [card.date];
  const dates = [];
  for (let time = from; time <= until; time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const noon = Date.parse(`${date}T12:00:00+05:30`);
    if (Number.isFinite(noon) && isTradingDay(noon)) dates.push(date);
  }
  return dates.length ? dates : [card.date];
}

export { hhmm as istHHMM };
