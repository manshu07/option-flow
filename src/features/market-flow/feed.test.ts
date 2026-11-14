import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marketSnapshot } from '../../../tests/e2e/fixtures/replay-fixture';
import { fetchMarketMinute, fetchReplayDays, fetchReplayFutures, fetchReplayManifest, sourceForDay } from './feed';

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
