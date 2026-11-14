import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarketFile } from '../options-scanner/contractScanModel';
import { combineMonths } from '../options-scanner/futuresModel';
import type { Underlying } from '@/lib/underlyings';
import { DEFAULT_FLOW_SETTINGS } from './marketFlowModel';
import { useReplayFlow } from './useReplayFlow';
import { FUTURES_AFTER_AS_OF, MANIFEST, MARKET_BY_MINUTE, REPLAY_DATE } from '../../../tests/e2e/fixtures/replay-fixture';

const feed = vi.hoisted(() => ({
  days: vi.fn(),
  manifest: vi.fn(),
  market: vi.fn(),
  futures: vi.fn(),
}));

vi.mock('./feed', () => ({
  fetchReplayDays: feed.days,
  sourceForDay: (day: { source?: string } | null | undefined) => day?.source === 'archive' || day?.source === 'live' ? day.source : null,
  fetchReplayManifest: feed.manifest,
  fetchMarketMinute: feed.market,
  fetchReplayFutures: feed.futures,
}));

const reliance = { symbol: 'RELIANCE', name: 'Reliance', apiKey: 'NSE:RELIANCE', lot: 500, kind: 'stock', exch: 'NSE' } as Underlying;
const universe = [reliance];
const marketAt = (minute: string) => parseMarketFile(MARKET_BY_MINUTE[minute as keyof typeof MARKET_BY_MINUTE])!;
const futures = combineMonths('RELIANCE', FUTURES_AFTER_AS_OF.months)!;
const useReplay = () => useReplayFlow(universe, DEFAULT_FLOW_SETTINGS, { requested: true, date: REPLAY_DATE });

beforeEach(() => {
  feed.days.mockResolvedValue([{ date: REPLAY_DATE, source: 'live', minutes: MANIFEST.minutes.length, firstAt: MANIFEST.start, lastAt: MANIFEST.end, futuresSymbols: ['RELIANCE'] }]);
  feed.manifest.mockResolvedValue(MANIFEST);
  feed.market.mockImplementation(async (_date: string, minute: string) => marketAt(minute));
  feed.futures.mockResolvedValue(futures);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('useReplayFlow', () => {
  it('retries the full session bootstrap if the final snapshot was not readable', async () => {
    let finalReads = 0;
    feed.market.mockImplementation(async (_date: string, minute: string) => {
      if (minute === '1530' && finalReads++ === 0) return null;
      return marketAt(minute);
    });
    const { result } = renderHook(useReplay);

    await waitFor(() => expect(result.current.error).toContain('1530'));
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.flow).not.toBeNull());

    expect(result.current.cursorLabel).toBe('09:15');
    expect(feed.futures).toHaveBeenCalledTimes(1);
  });

  it('retries only missing futures when the saved futures file becomes readable', async () => {
    feed.futures.mockResolvedValueOnce(null).mockResolvedValueOnce(futures);
    const { result } = renderHook(useReplay);

    await waitFor(() => expect(result.current.retryableFutures).toBe(true));
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.retryableFutures).toBe(false));

    expect(feed.futures).toHaveBeenCalledTimes(2);
    expect(result.current.cursorLabel).toBe('09:15');
  });

  it('ignores an older minute response after a newer seek', async () => {
    let resolveOlder!: (market: ReturnType<typeof marketAt>) => void;
    let olderReadStarted = false;
    feed.market.mockImplementation(async (_date: string, minute: string) => {
      if (minute === '0930') return await new Promise<ReturnType<typeof marketAt>>(resolve => { resolveOlder = resolve; olderReadStarted = true; });
      return marketAt(minute);
    });
    const { result } = renderHook(useReplay);
    await waitFor(() => expect(result.current.flow).not.toBeNull());
    expect(result.current.cursorLabel).toBe('09:15');

    act(() => result.current.seek(1));
    expect(result.current.market?.at).toBe(marketAt('0915').at);
    expect(result.current.flow?.asOf).toBe(marketAt('0915').at);
    await waitFor(() => expect(olderReadStarted).toBe(true));

    act(() => result.current.seek(2));
    await waitFor(() => expect(result.current.market?.at).toBe(marketAt('1000').at));

    await act(async () => resolveOlder(marketAt('0930')));
    expect(result.current.market?.at).toBe(marketAt('1000').at);
    expect(result.current.flow?.asOf).toBe(marketAt('1000').at);
  });

  it('uses archive routes for an archived catalog day and never live routes', async () => {
    feed.days.mockResolvedValue([{ date: REPLAY_DATE, source: 'archive', minutes: MANIFEST.minutes.length, firstAt: MANIFEST.start, lastAt: MANIFEST.end, futuresSymbols: ['RELIANCE'] }]);
    const { result } = renderHook(useReplay);

    await waitFor(() => expect(result.current.flow).not.toBeNull());
    expect(feed.days.mock.invocationCallOrder[0]).toBeLessThan(feed.manifest.mock.invocationCallOrder[0]);
    expect(feed.manifest).toHaveBeenCalledWith(REPLAY_DATE, expect.any(AbortSignal), 'archive');
    expect(feed.market.mock.calls.every(([, , , source]) => source === 'archive')).toBe(true);
    expect(feed.futures.mock.calls.every(([, , , , source]) => source === 'archive')).toBe(true);
    expect(feed.market.mock.calls.some(([, , , source]) => source === 'live')).toBe(false);
  });

  it('stays recoverably in error when the catalog fails for a requested archived date', async () => {
    feed.days.mockRejectedValue(new Error('catalog unavailable'));
    const { result } = renderHook(useReplay);

    await waitFor(() => expect(result.current.error).toContain('Replay catalog unavailable'));
    expect(result.current.loading).toBe(false);
    expect(feed.manifest).not.toHaveBeenCalled();
    expect(feed.market).not.toHaveBeenCalled();
  });

  it('keeps an empty custom window recoverable and resets to Full day', async () => {
    const { result } = renderHook(useReplay);
    await waitFor(() => expect(result.current.flow).not.toBeNull());

    act(() => result.current.setWindow('custom', '11:00', '11:01'));
    await waitFor(() => expect(result.current.error).toContain('No captured minutes in this window'));
    expect(result.current.manifest).not.toBeNull();
    expect(result.current.loading).toBe(false);

    act(() => result.current.setWindow('full'));
    await waitFor(() => expect(result.current.flow).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.window).toBe('full');
  });

  it('rejects an archived selection with a missing or unknown source', async () => {
    feed.days.mockResolvedValue([{ date: REPLAY_DATE, source: 'recorded', minutes: MANIFEST.minutes.length, firstAt: MANIFEST.start, lastAt: MANIFEST.end, futuresSymbols: ['RELIANCE'] }]);
    const { result } = renderHook(useReplay);

    await waitFor(() => expect(result.current.error).toContain('invalid source'));
    expect(feed.manifest).not.toHaveBeenCalled();
    expect(feed.market).not.toHaveBeenCalled();
  });

  it('switches sessions and resets the cursor to the first captured minute', async () => {
    const secondDate = '2026-10-29';
    const secondManifest = { ...MANIFEST, date: secondDate, minutes: ([...MANIFEST.minutes] as Array<[string, number]>).map(([minute]) => [minute, Date.parse(`${secondDate}T${minute.slice(0, 2)}:${minute.slice(2)}:00+05:30`)] as [string, number]) };
    feed.days.mockResolvedValue([
      { date: REPLAY_DATE, source: 'live', minutes: MANIFEST.minutes.length, firstAt: MANIFEST.start, lastAt: MANIFEST.end, futuresSymbols: ['RELIANCE'] },
      { date: secondDate, source: 'archive', minutes: secondManifest.minutes.length, firstAt: secondManifest.start, lastAt: secondManifest.end, futuresSymbols: ['RELIANCE'] },
    ]);
    feed.manifest.mockImplementation(async (date: string) => date === secondDate ? secondManifest : MANIFEST);
    const { result } = renderHook(useReplay);
    await waitFor(() => expect(result.current.flow).not.toBeNull());

    act(() => result.current.selectDay(secondDate));
    await waitFor(() => expect(result.current.cursorLabel).toBe('09:15'));
    expect(result.current.mode.cursorIndex).toBe(0);
    expect(feed.manifest).toHaveBeenLastCalledWith(secondDate, expect.any(AbortSignal), 'archive');
  });

  it('keeps a completed flow visible while fake-timer playback advances', async () => {
    const { result } = renderHook(useReplay);
    await waitFor(() => expect(result.current.flow).not.toBeNull());
    vi.useFakeTimers();

    act(() => result.current.togglePlay());
    for (let i = 0; i < 3; i += 1) act(() => vi.advanceTimersByTime(700));
    expect(result.current.flow).not.toBeNull();
  });

  it('prefetches the next five minutes in order and serves a cached seek', async () => {
    const { result } = renderHook(useReplay);
    await waitFor(() => expect(feed.market.mock.calls.filter(([, minute]) => minute !== '1530').length).toBeGreaterThanOrEqual(6));
    const minutes = feed.market.mock.calls.slice(1, 7).map(([, minute]) => minute);
    expect(minutes).toEqual(['0915', '0930', '1000', '1445', '1447', '1450']);
    const before = feed.market.mock.calls.filter(([, minute]) => minute === '0930').length;
    act(() => result.current.seek(1));
    await waitFor(() => expect(result.current.cursorLabel).toBe('09:30'));
    expect(feed.market.mock.calls.filter(([, minute]) => minute === '0930').length).toBe(before);
  });

  it('does not touch replay routes when replay is closed for the same live date', () => {
    renderHook(() => useReplayFlow(universe, DEFAULT_FLOW_SETTINGS, { requested: false, date: REPLAY_DATE }));
    expect(feed.days).not.toHaveBeenCalled();
    expect(feed.manifest).not.toHaveBeenCalled();
    expect(feed.market).not.toHaveBeenCalled();
    expect(feed.futures).not.toHaveBeenCalled();
  });
});
