import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marketSnapshot } from '../../../tests/e2e/fixtures/replay-fixture';
import { clearFuturesCache, fetchMarketMinute, fetchPcrContext, fetchReplayDays, fetchReplayFutures, fetchReplayManifest, getCachedFutures, putCachedFutures, sourceForDay, useFuturesFeed } from './feed';
import type { FeedStatus } from './feed';

const DATE = '2026-10-30';
const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body });

describe('replay feed routes', () => {
  const request = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', request);
    request.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses the replay catalog URL exactly', async () => {
    request.mockResolvedValue(jsonResponse([]));
    await fetchReplayDays();
    expect(request).toHaveBeenCalledWith('/api/replay/days', expect.objectContaining({ cache: 'no-store' }));
  });

  it('uses exact archive manifest, minute, and futures contracts', async () => {
    request.mockResolvedValueOnce(jsonResponse({ providerId: 'archive', date: DATE, minutesIndex: [['0915', 1]], futures: {} }));
    await fetchReplayManifest(DATE, undefined, 'archive');
    expect(request).toHaveBeenLastCalledWith(`/api/archive/${DATE}/manifest`, expect.objectContaining({ cache: 'no-store' }));

    request.mockResolvedValueOnce(jsonResponse(marketSnapshot('0915', 1000)));
    await fetchMarketMinute(DATE, '0915', undefined, 'archive');
    expect(request).toHaveBeenLastCalledWith(`/api/archive/${DATE}/minute/0915`, expect.any(Object));

    request.mockResolvedValueOnce(jsonResponse({ symbol: 'RELIANCE', months: [] }));
    await fetchReplayFutures('RELIANCE', DATE, '0915', undefined, 'archive');
    expect(request).toHaveBeenLastCalledWith(`/api/archive/${DATE}/futures/RELIANCE?asOf=0915`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('uses exact live-day contracts only for an explicit live source', async () => {
    request.mockResolvedValueOnce(jsonResponse({ provider: { id: 'live', label: 'Live' }, date: DATE, minutes: [['0915', 1]], futures: {} }));
    await fetchReplayManifest(DATE, undefined, 'live');
    expect(request).toHaveBeenLastCalledWith(`/api/replay/${DATE}/manifest`, expect.objectContaining({ cache: 'no-store' }));

    request.mockResolvedValueOnce(jsonResponse(marketSnapshot('0915', 1000)));
    await fetchMarketMinute(DATE, '0915', undefined, 'live');
    expect(request).toHaveBeenLastCalledWith(`/api/market/${DATE}/0915`, expect.any(Object));

    request.mockResolvedValueOnce(jsonResponse({ symbol: 'RELIANCE', months: [] }));
    await fetchReplayFutures('RELIANCE', DATE, '0915', undefined, 'live');
    expect(request).toHaveBeenLastCalledWith(`/api/replay/${DATE}/futures/RELIANCE?asOf=0915`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('rejects missing and unknown day sources instead of treating them as live', () => {
    expect(sourceForDay({ source: 'archive' })).toBe('archive');
    expect(sourceForDay({ source: 'live' })).toBe('live');
    expect(sourceForDay({ source: undefined })).toBeNull();
    expect(sourceForDay({ source: 'recorded' })).toBeNull();
  });

  it('does not issue a live request for an invalid direct source', async () => {
    await expect(fetchReplayManifest(DATE, undefined, 'recorded' as 'live')).rejects.toThrow('Invalid replay source');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('live PCR context endpoint', () => {
  const request = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', request);
    request.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads /api/pcr and keeps nullable ratios/shifts safe', async () => {
    request.mockResolvedValue(jsonResponse([
      { symbol: 'NIFTY', pcr: 0.87, pcrShift15m: -4, ts: 1234 },
      { symbol: 'BANKNIFTY', pcr: NaN, pcrShift15m: null, ts: 1234 },
      { symbol: '', pcr: 1, pcrShift15m: 0, ts: 1234 },
    ]));
    expect(await fetchPcrContext()).toEqual([
      { symbol: 'NIFTY', pcr: 0.87, pcrShift15m: -4, ts: 1234 },
      { symbol: 'BANKNIFTY', pcr: null, pcrShift15m: null, ts: 1234 },
    ]);
    expect(request).toHaveBeenCalledWith('/api/pcr', expect.objectContaining({ cache: 'no-store' }));
  });
});

describe('futures stale-while-revalidate cache', () => {
  const session = '2026-11-16';
  const symbols = ['NIFTY', 'SENSEX'];
  const status: FeedStatus = { provider: { id: 'dhan', label: 'Dhan', alwaysLive: false }, ready: true, session, lastError: null };

  const future = (symbol: string) => ({
    symbol,
    contractDate: '2026-11-19',
    months: ['2026-11-19'],
    prevClose: 100,
    prevOi: 1_000,
    candles: [{ at: Date.parse('2026-11-16T03:45:00Z'), close: 101, oi: 1_100 }],
  });

  beforeEach(() => clearFuturesCache());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearFuturesCache();
  });

  it('isolates cached symbols by session and never stores null', () => {
    const nifty = future('NIFTY');
    const sensex = future('SENSEX');
    putCachedFutures(session, 'NIFTY', nifty);
    putCachedFutures(session, 'SENSEX', sensex);
    putCachedFutures(session, 'BANKNIFTY', null);

    expect(getCachedFutures(session, 'NIFTY')).toEqual(nifty);
    expect(getCachedFutures(session, 'SENSEX')).toEqual(sensex);
    expect(getCachedFutures(session, 'BANKNIFTY')).toBeNull();
    expect(getCachedFutures('2026-11-17', 'NIFTY')).toBeNull();
  });

  it('starts an empty first mount at zero and counts successful futures as they arrive', async () => {
    const request = vi.fn((input: RequestInfo | URL) => {
      const symbol = String(input).includes('/SENSEX?') ? 'SENSEX' : 'NIFTY';
      return Promise.resolve({ ok: true, json: async () => ({ months: [{ date: '2026-11-19', prevClose: 100, prevOi: 1_000, candles: future(symbol).candles }] }) });
    });
    vi.stubGlobal('fetch', request);

    const { result, unmount } = renderHook(() => useFuturesFeed(symbols, true, status));
    expect(result.current.read).toBe(0);
    await waitFor(() => expect(result.current.read).toBe(2));
    expect(result.current.series.get('NIFTY')?.candles[0]?.close).toBe(101);
    expect(result.current.series.get('SENSEX')?.candles[0]?.close).toBe(101);
    unmount();
  });

  it('paints all cached series on remount before background refresh resolves, while still refetching every symbol', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const symbol = String(input).includes('/SENSEX?') ? 'SENSEX' : 'NIFTY';
      return Promise.resolve({ ok: true, json: async () => ({ months: [{ date: '2026-11-19', prevClose: 100, prevOi: 1_000, candles: future(symbol).candles }] }) });
    }));
    const first = renderHook(() => useFuturesFeed(symbols, true, status));
    await waitFor(() => expect(first.result.current.read).toBe(2));
    first.unmount();

    const pendingFetch = vi.fn(() => new Promise<never>(() => undefined));
    vi.stubGlobal('fetch', pendingFetch);
    const second = renderHook(() => useFuturesFeed(symbols, true, status));

    expect(second.result.current.read).toBe(2);
    expect(second.result.current.series.get('NIFTY')?.candles[0]?.close).toBe(101);
    expect(second.result.current.series.get('SENSEX')?.candles[0]?.close).toBe(101);
    await waitFor(() => expect(pendingFetch).toHaveBeenCalledTimes(2));
    second.unmount();
  });
});
