import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { futuresCoverage, mergeFutures, persistFutures, readFutures, readReplayMinutes, ReplayDataError, truncateFutures } from './replayStorage.mjs';

const DATE = '2026-11-06';
const OPEN = Date.parse(`${DATE}T09:15:00+05:30`);
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('replay futures storage', () => {
  it('merges candles by month and atomically replaces one symbol file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-replay-'));
    dirs.push(dir);
    persistFutures(dir, DATE, 'NIFTY', {
      months: [{ date: '2026-11-26', prevClose: 100, prevOi: 10, candles: [{ at: OPEN, close: 101, oi: 11 }] }],
    });
    const merged = persistFutures(dir, DATE, 'NIFTY', {
      months: [{ date: '2026-11-26', candles: [{ at: OPEN, close: 102, oi: 12 }, { at: OPEN + 60_000, close: 103, oi: 13 }] }],
    });
    expect(merged.months[0].candles).toEqual([
      { at: OPEN, close: 102, oi: 12 },
      { at: OPEN + 60_000, close: 103, oi: 13 },
    ]);
    expect(readFutures(dir, DATE, 'NIFTY')).toEqual(merged);
    expect(fs.readdirSync(path.join(dir, DATE, 'futures'))).toEqual(['NIFTY.json']);
  });

  it('does not include a candle that starts at the replay cursor', () => {
    const result = { symbol: 'NIFTY', session: DATE, months: [{ date: '2026-11-26', candles: [
      { at: OPEN, close: 101, oi: 11 },
      { at: OPEN + 60_000, close: 102, oi: 12 },
    ] }] };
    expect(truncateFutures(result, OPEN + 60_000).months[0].candles).toEqual([{ at: OPEN, close: 101, oi: 11 }]);
  });

  it('reports candle coverage as a half-open time range', () => {
    expect(futuresCoverage({ months: [{ date: '2026-11-26', candles: [{ at: OPEN, close: 101, oi: 11 }, { at: OPEN + 60_000, close: 102, oi: 12 }] }] })).toEqual({
      available: true, months: ['2026-11-26'], firstAt: OPEN, lastAt: OPEN + 60_000, start: OPEN, end: OPEN + 120_000,
    });
    expect(futuresCoverage({ months: [] })).toEqual({ available: false, months: [], firstAt: null, lastAt: null, start: null, end: null });
  });

  it('rejects path traversal identifiers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-replay-'));
    dirs.push(dir);
    expect(() => persistFutures(dir, '../outside', 'NIFTY', { months: [] })).toThrow(/Invalid replay futures path/);
    expect(() => persistFutures(dir, DATE, '../outside', { months: [] })).toThrow(/Invalid replay futures path/);
  });

  it('recovers a corrupt prior futures file when a fresh provider read arrives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-replay-'));
    dirs.push(dir);
    const futuresDir = path.join(dir, DATE, 'futures');
    fs.mkdirSync(futuresDir, { recursive: true });
    fs.writeFileSync(path.join(futuresDir, 'NIFTY.json'), JSON.stringify({ symbol: 'NIFTY', session: DATE, months: [null] }));

    const saved = persistFutures(dir, DATE, 'NIFTY', {
      months: [{ date: '2026-11-26', prevClose: 100, prevOi: 10, candles: [{ at: OPEN, close: 101, oi: 11 }] }],
    });
    expect(readFutures(dir, DATE, 'NIFTY')).toEqual(saved);
  });

  it('rejects structurally malformed persisted futures as replay data errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-replay-'));
    dirs.push(dir);
    const futuresDir = path.join(dir, DATE, 'futures');
    fs.mkdirSync(futuresDir, { recursive: true });
    fs.writeFileSync(path.join(futuresDir, 'NIFTY.json'), JSON.stringify({ symbol: 'NIFTY', session: DATE, months: [null] }));

    expect(() => readFutures(dir, DATE, 'NIFTY')).toThrow(ReplayDataError);
    expect(() => truncateFutures({ symbol: 'NIFTY', session: DATE, months: [null] }, OPEN)).toThrow(ReplayDataError);
    expect(futuresCoverage({ months: [null] })).toMatchObject({ available: false, months: [], firstAt: null, lastAt: null });
  });

  it('validates the replay minute index instead of accepting malformed JSON or entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-replay-'));
    dirs.push(dir);
    const sessionDir = path.join(dir, DATE);
    fs.mkdirSync(sessionDir, { recursive: true });
    const index = path.join(sessionDir, 'index.json');
    const sameDate = (date: string, minute: string, at: number) => date === DATE && at === Date.parse(`${date}T${minute.slice(0, 2)}:${minute.slice(2)}:00+05:30`);

    fs.writeFileSync(index, JSON.stringify([['0915', OPEN], ['0916', OPEN + 60_000]]));
    expect(readReplayMinutes(dir, DATE, sameDate)).toEqual([['0915', OPEN], ['0916', OPEN + 60_000]]);

    fs.writeFileSync(index, '{broken');
    expect(() => readReplayMinutes(dir, DATE, sameDate)).toThrow(ReplayDataError);
    fs.writeFileSync(index, JSON.stringify({ minutes: [] }));
    expect(() => readReplayMinutes(dir, DATE, sameDate)).toThrow(ReplayDataError);
    fs.writeFileSync(index, JSON.stringify([['0916', OPEN]]));
    expect(() => readReplayMinutes(dir, DATE, sameDate)).toThrow(ReplayDataError);
  });
});

describe('mergeFutures', () => {
  it('keeps previous month metadata when a later response omits it', () => {
    expect(mergeFutures(
      { months: [{ date: '2026-11-26', prevClose: 100, prevOi: 5, candles: [] }] },
      { symbol: 'NIFTY', session: DATE, months: [{ date: '2026-11-26', candles: [] }] },
    ).months[0]).toMatchObject({ date: '2026-11-26', prevClose: 100, prevOi: 5 });
  });
});
