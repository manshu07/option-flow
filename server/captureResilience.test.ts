import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendTickJournalBatch,
  collectTickJournalBatch,
  createBootCrawlPacer,
  mergeDhanFuturesCandle,
  parseTodayIntraday,
  replayTickJournalText,
  shouldBackfillToday,
  shouldRunTodayBackfill,
} from './providers/dhan.mjs';

const SESSION = '2026-11-20';
const minute = (hour: number, min: number) => Date.parse(`${SESSION}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+05:30`);
const dirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-capture-resilience-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('capture resilience helpers', () => {
  it('field-merges REST and feed candles without losing extrema; feed close/OI win', () => {
    expect(mergeDhanFuturesCandle(
      { at: 1, open: 100, high: 110, low: 95, close: 103, oi: 100, volume: 10 },
      { at: 1, open: 102, high: 108, low: 90, close: 105, oi: 120, volume: 15 },
    )).toEqual({ at: 1, open: 100, high: 110, low: 90, close: 105, oi: 120, volume: 15 });
  });

  it('requests today REST only for sparse stale in-session futures, not fresh or out-of-session data', () => {
    const now = minute(11, 0);
    const sparseStale = Array.from({ length: 10 }, (_, i) => ({ at: minute(9, 15 + i), close: 100, oi: 10 }));
    const sufficientStale = Array.from({ length: 30 }, (_, i) => ({ at: minute(9, 15 + i), close: 100, oi: 10 }));
    const sparseFresh = [{ at: now - 30_000, close: 100, oi: 10 }];
    expect(shouldBackfillToday(sparseStale, now, SESSION)).toBe(true);
    expect(shouldBackfillToday(sufficientStale, now, SESSION)).toBe(false);
    expect(shouldBackfillToday(sparseFresh, now, SESSION)).toBe(false);
    expect(shouldBackfillToday(sparseStale, now, '2026-11-19')).toBe(false);
    expect(shouldBackfillToday(sparseStale, minute(18, 0), SESSION)).toBe(false);
  });

  it('keeps the backfill session guard separate from force/staleness selection', () => {
    expect(shouldRunTodayBackfill(minute(11, 0), SESSION)).toBe(true);
    expect(shouldRunTodayBackfill(minute(18, 0), SESSION)).toBe(false);
    expect(shouldRunTodayBackfill(minute(11, 0), SESSION, { postClose: true })).toBe(false);
    expect(shouldRunTodayBackfill(minute(18, 0), SESSION, { postClose: true })).toBe(true);
    expect(shouldRunTodayBackfill(minute(18, 0), '2026-11-19', { postClose: true })).toBe(false);
  });

  it('normalizes one-day intraday responses and excludes other dates or invalid rows', () => {
    const rows = parseTodayIntraday({
      timestamp: [minute(9, 15) / 1000, minute(9, 16) / 1000, minute(9, 17) / 1000, minute(9, 18) / 1000],
      open: [100, 101, 102, 103], high: [102, 103, 104, 104], low: [99, 100, 101, 102],
      close: [101, 102, null, 103], open_interest: [10, 11, 12, -1], volume: [1, 2, 3, 4],
    }, SESSION);
    expect(rows).toEqual([
      { at: minute(9, 15), open: 100, high: 102, low: 99, close: 101, oi: 10, volume: 1 },
      { at: minute(9, 16), open: 101, high: 103, low: 100, close: 102, oi: 11, volume: 2 },
    ]);
  });

  it('replays expiry-qualified tick journal rows once and appends one changed batch', () => {
    const futTicks = new Map();
    const journaled = new Map();
    const at = minute(9, 15);
    const rows = [
      { at, sym: 'NIFTY', expiry: '2026-11-26', o: 100, h: 105, l: 99, c: 103, oi: 10, v: 1 },
      { at, sym: 'NIFTY', expiry: '2026-12-31', o: 200, h: 205, l: 199, c: 203, oi: 20, v: 2 },
      { at, sym: 'NIFTY', expiry: '2026-11-26', o: 101, h: 108, l: 98, c: 104, oi: 12, v: 3 },
    ];
    const replayed = replayTickJournalText(rows.map(row => JSON.stringify(row)).join('\n'), SESSION,
      (_symbol, expiry) => expiry === '2026-11-26' ? 'near-id' : expiry === '2026-12-31' ? 'next-id' : null,
      futTicks, journaled);
    const contracts = [
      { id: 'near-id', symbol: 'NIFTY', expiry: '2026-11-26' },
      { id: 'next-id', symbol: 'NIFTY', expiry: '2026-12-31' },
    ];

    expect(replayed).toEqual({ restored: 3, invalid: 0 });
    expect(futTicks.get('near-id').get(at)).toMatchObject({ high: 108, low: 98, close: 104, oi: 12 });
    expect(futTicks.get('next-id').get(at)).toMatchObject({ high: 205, low: 199, close: 203, oi: 20 });
    expect(collectTickJournalBatch(contracts, futTicks, SESSION, journaled).records).toEqual([]);

    futTicks.get('near-id').set(at, mergeDhanFuturesCandle(futTicks.get('near-id').get(at), {
      at, open: 101, high: 110, low: 97, close: 106, oi: 13, volume: 4,
    }));
    const changed = collectTickJournalBatch(contracts, futTicks, SESSION, journaled);
    expect(changed.records).toHaveLength(1);
    expect(changed.records[0]).toMatchObject({ sym: 'NIFTY', expiry: '2026-11-26', at, h: 110, l: 97, c: 106, oi: 13 });
    const append = vi.fn();
    expect(appendTickJournalBatch(path.join(tempDir(), SESSION, 'futures-ticks.ndjson'), changed.records, append)).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(append.mock.calls[0][1]).trim())).toMatchObject({ sym: 'NIFTY', expiry: '2026-11-26', at });
  });

  it('paces concurrent option-chain crawls only in the first ten in-session boot minutes', async () => {
    const bootAt = minute(9, 15);
    let now = bootAt;
    const waits: number[] = [];
    const pace = createBootCrawlPacer({
      bootAt,
      paceMs: 250,
      startedInSession: true,
      now: () => now,
      sleep: async ms => { waits.push(ms); now += ms; },
    });
    await Promise.all([pace(), pace(), pace()]);
    expect(waits).toEqual([250, 250]);

    now = bootAt + 10 * 60_000;
    await Promise.all([pace(), pace()]);
    expect(waits).toEqual([250, 250]);

    const preMarketWaits: number[] = [];
    const preMarket = createBootCrawlPacer({
      bootAt: minute(8, 0),
      paceMs: 250,
      startedInSession: false,
      now: () => minute(9, 16),
      sleep: async ms => { preMarketWaits.push(ms); },
    });
    await preMarket();
    expect(preMarketWaits).toEqual([]);
  });

});
