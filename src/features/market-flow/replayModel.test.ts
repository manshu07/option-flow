import { beforeEach, describe, expect, it } from 'vitest';
import type { FuturesSeries } from '../options-scanner/futuresModel';
import { advanceReplay, boardReplayMinutes, clipReplayMinutes, isReplayableDay, loadPlaybackSpeed, playbackIntervalMs, rememberMarketMinute, replayRange, savePlaybackSpeed, sliceFuturesSeries } from './replayModel';

const MINUTE = 60_000;
const series: FuturesSeries = {
  symbol: 'AAA', contractDate: '2026-10-27', months: ['2026-10-27'], prevClose: 100, prevOi: 10,
  candles: [0, 1, 2].map(i => ({ at: 1_000 + i * MINUTE, close: 100 + i, oi: 10 + i })),
};

describe('replay model', () => {
  beforeEach(() => localStorage.clear());

  it('keeps only futures candles completed by the cursor', () => {
    expect(sliceFuturesSeries(series, 1_000 + 2 * MINUTE).candles.map(candle => candle.at)).toEqual([1_000, 1_000 + MINUTE]);
    expect(sliceFuturesSeries(series, 1_000 + 3 * MINUTE).candles).toEqual(series.candles);
  });

  it('advances through captured minutes and stops at the final cursor', () => {
    expect(advanceReplay({ mode: 'replay', playing: true, cursorIndex: 0 }, 2)).toMatchObject({ cursorIndex: 1, playing: true });
    expect(advanceReplay({ mode: 'replay', playing: true, cursorIndex: 2 }, 2)).toMatchObject({ cursorIndex: 2, playing: false });
    expect(advanceReplay({ mode: 'live', playing: true, cursorIndex: 0 }, 2)).toMatchObject({ mode: 'live', cursorIndex: 0 });
  });

  it('renders the actual capture range without inventing a session open', () => {
    expect(replayRange(10, 20, value => String(value))).toBe('10–20');
    expect(replayRange(null, null, value => String(value))).toBe('No captured minutes');
  });

  it("keeps replay inside the date-aware derivatives session window", () => {
    const date = '2026-11-13';
    const at = (time: string) => Date.parse(`${date}T${time}:00+05:30`);
    const minutes: Array<[string, number]> = [['0914', at('09:14')], ['0915', at('09:15')], ['1530', at('15:30')], ['1540', at('15:40')]];
    expect(boardReplayMinutes(date, minutes)).toEqual([['0915', at('09:15')], ['1530', at('15:30')], ['1540', at('15:40')]]);
  });

  it('bounds the market-minute cache and refreshes a revisited minute', () => {
    const one = { value: 1 };
    const two = { value: 2 };
    const three = { value: 3 };
    const four = { value: 4 };
    let cache = new Map<string, { value: number }>();
    cache = rememberMarketMinute(cache, '0915', one, 3);
    cache = rememberMarketMinute(cache, '0916', two, 3);
    cache = rememberMarketMinute(cache, '0917', three, 3);
    cache = rememberMarketMinute(cache, '0918', four, 3);
    expect([...cache.keys()]).toEqual(['0916', '0917', '0918']);
    cache = rememberMarketMinute(cache, '0917', { value: 30 }, 3);
    expect([...cache.keys()]).toEqual(['0916', '0918', '0917']);
    expect(cache.get('0917')).toEqual({ value: 30 });
  });

  it('maps playback speeds to deterministic intervals and persists the choice', () => {
    expect([0.5, 1, 2, 5].map(speed => playbackIntervalMs(speed as 0.5 | 1 | 2 | 5))).toEqual([1400, 700, 350, 140]);
    expect(loadPlaybackSpeed()).toBe(1);
    savePlaybackSpeed(5);
    expect(loadPlaybackSpeed()).toBe(5);
  });

  it('clips windows against fixed date-aware session bounds', () => {
    const date = '2026-10-30';
    const at = (time: string) => Date.parse(`${date}T${time}:00+05:30`);
    const minutes: Array<[string, number]> = ['0915', '1200', '1230', '1300', '1440', '1540'].map(minute => [minute, at(`${minute.slice(0, 2)}:${minute.slice(2)}`)]);
    expect(clipReplayMinutes(date, minutes, { window: 'morning' }).map(([minute]) => minute)).toEqual(['0915', '1200', '1230']);
    expect(clipReplayMinutes(date, minutes, { window: 'afternoon' }).map(([minute]) => minute)).toEqual(['1230', '1300', '1440', '1540']);
    expect(clipReplayMinutes(date, minutes, { window: 'last-hour' }).map(([minute]) => minute)).toEqual(['1440', '1540']);
    expect(clipReplayMinutes(date, minutes, { window: 'custom', start: '12:00', end: '13:00' }).map(([minute]) => minute)).toEqual(['1200', '1230', '1300']);
  });

  it('marks empty or missing-coverage days unavailable', () => {
    expect(isReplayableDay({ minutes: 0, firstAt: null, lastAt: null })).toBe(false);
    expect(isReplayableDay({ minutes: 2, firstAt: 1, lastAt: 2 })).toBe(true);
  });

  it('uses at least a forty-minute LRU by default', () => {
    let cache = new Map<string, number>();
    for (let i = 0; i < 41; i += 1) cache = rememberMarketMinute(cache, String(i), i);
    expect(cache.size).toBe(40);
    expect(cache.has('0')).toBe(false);
    expect(cache.has('1')).toBe(true);
  });
});
