import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMarketFile } from '../options-scanner/contractScanModel';
import { combineMonths } from '../options-scanner/futuresModel';
import type { Underlying } from '@/lib/underlyings';
import { DEFAULT_FLOW_SETTINGS } from './marketFlowModel';
import { useReplayFlow } from './useReplayFlow';
import { FUTURES_AFTER_AS_OF, MANIFEST, MARKET_BY_MINUTE, REPLAY_DATE } from '../../../tests/e2e/fixtures/replay-fixture';

const feed = vi.hoisted(() => ({
  manifest: vi.fn(),
  market: vi.fn(),
  futures: vi.fn(),
}));

vi.mock('./feed', () => ({
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
  feed.manifest.mockResolvedValue(MANIFEST);
  feed.market.mockImplementation(async (_date: string, minute: string) => marketAt(minute));
  feed.futures.mockResolvedValue(futures);
});

afterEach(() => {
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
    expect(result.current.market).toBeNull();
    expect(result.current.flow).toBeNull();
    await waitFor(() => expect(olderReadStarted).toBe(true));

    act(() => result.current.seek(2));
    await waitFor(() => expect(result.current.market?.at).toBe(marketAt('1000').at));

    await act(async () => resolveOlder(marketAt('0930')));
    expect(result.current.market?.at).toBe(marketAt('1000').at);
    expect(result.current.flow?.asOf).toBe(marketAt('1000').at);
  });
});
