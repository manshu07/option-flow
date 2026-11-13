import fs from 'node:fs';
import path from 'node:path';

export const REPLAY_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const REPLAY_SYMBOL = /^[A-Z0-9&._-]{1,40}$/;

export class ReplayDataError extends Error {
  constructor(message) {
    super(message);
    this.code = 'REPLAY_DATA_INVALID';
  }
}

function validCandle(candle) {
  return Boolean(candle && Number.isSafeInteger(candle.at) && Number.isFinite(candle.close) && candle.close > 0 && Number.isFinite(candle.oi) && candle.oi >= 0);
}

function validMonth(month) {
  return Boolean(
    month && REPLAY_DATE.test(month.date) && Array.isArray(month.candles)
    && (month.prevClose == null || (Number.isFinite(month.prevClose) && month.prevClose > 0))
    && (month.prevOi == null || (Number.isFinite(month.prevOi) && month.prevOi >= 0))
    && month.candles.every(validCandle),
  );
}

function validSnapshot(value, date, symbol) {
  return Boolean(
    value && value.symbol === symbol && value.session === date && Array.isArray(value.months)
    && value.months.every(validMonth),
  );
}

function futuresPath(scanDir, date, symbol) {
  if (!REPLAY_DATE.test(date) || !REPLAY_SYMBOL.test(symbol)) return null;
  return path.join(scanDir, date, 'futures', `${symbol}.json`);
}

function mergeMonths(previous, incoming) {
  const byDate = new Map();
  for (const month of [...(previous ?? []), ...(incoming ?? [])]) {
    if (!month || typeof month.date !== 'string') continue;
    const held = byDate.get(month.date);
    const candles = new Map((held?.candles ?? []).map(candle => [candle.at, candle]));
    for (const candle of month.candles ?? []) {
      if (candle && Number.isFinite(candle.at)) candles.set(candle.at, candle);
    }
    byDate.set(month.date, {
      ...(held ?? {}),
      ...month,
      candles: [...candles.values()].sort((a, b) => a.at - b.at),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeFutures(previous, incoming) {
  return {
    symbol: incoming.symbol,
    session: incoming.session,
    months: mergeMonths(previous?.months, incoming.months),
  };
}

export function readReplayMinutes(scanDir, date, matchesTimestamp = () => true) {
  if (!REPLAY_DATE.test(date)) throw new ReplayDataError('Invalid replay date.');
  const file = path.join(scanDir, date, 'index.json');
  if (!fs.existsSync(file)) return null;
  let minutes;
  try { minutes = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new ReplayDataError('Invalid replay minute index.'); }
  if (!Array.isArray(minutes)) throw new ReplayDataError('Invalid replay minute index.');

  let previousAt = -Infinity;
  for (const entry of minutes) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new ReplayDataError('Invalid replay minute index.');
    const [minute, at] = entry;
    if (typeof minute !== 'string' || !/^\d{4}$/.test(minute) || !Number.isSafeInteger(at) || at <= previousAt) throw new ReplayDataError('Invalid replay minute index.');
    const hour = Number(minute.slice(0, 2));
    const minuteOfHour = Number(minute.slice(2));
    if (hour > 23 || minuteOfHour > 59 || !matchesTimestamp(date, minute, at)) throw new ReplayDataError('Invalid replay minute index.');
    previousAt = at;
  }
  return minutes;
}

export function persistFutures(scanDir, date, symbol, result) {
  const target = futuresPath(scanDir, date, symbol);
  if (!target) throw new Error('Invalid replay futures path.');
  if (!validSnapshot({ symbol, session: date, months: result?.months }, date, symbol)) throw new ReplayDataError('Invalid futures data.');
  let existing = null;
  try {
    existing = readFutures(scanDir, date, symbol);
  } catch (error) {
    if (error?.code !== 'REPLAY_DATA_INVALID') throw error;
  }
  const merged = mergeFutures(existing, { symbol, session: date, months: result.months });
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.${symbol}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(merged));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return merged;
}

export function readFutures(scanDir, date, symbol) {
  const file = futuresPath(scanDir, date, symbol);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validSnapshot(value, date, symbol)) throw new ReplayDataError('Invalid persisted futures data.');
    return value;
  } catch {
    throw new ReplayDataError('Invalid persisted futures data.');
  }
}

export function truncateFutures(result, cursorEpochMs) {
  if (!validSnapshot(result, result?.session, result?.symbol) || !Number.isFinite(cursorEpochMs)) throw new ReplayDataError('Invalid replay futures data.');
  return {
    symbol: result.symbol,
    session: result.session,
    months: result.months.map(month => ({
      ...month,
      candles: (month.candles ?? []).filter(candle => candle.at + 60_000 <= cursorEpochMs),
    })),
  };
}

export function futuresCoverage(result) {
  const validMonths = Array.isArray(result?.months) ? result.months.filter(validMonth) : [];
  const candles = validMonths.flatMap(month => month.candles);
  const months = validMonths.map(month => month.date);
  if (!candles.length) return { available: false, months, firstAt: null, lastAt: null, start: null, end: null };
  const firstAt = Math.min(...candles.map(candle => candle.at));
  const lastAt = Math.max(...candles.map(candle => candle.at));
  return {
    available: true,
    months,
    firstAt,
    lastAt,
    start: firstAt,
    end: lastAt + 60_000,
  };
}
