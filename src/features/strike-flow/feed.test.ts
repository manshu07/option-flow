import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint } from './feed';
import { fetchStrikeFlow } from './feed';

const payload: StrikeFlowPayload = {
  symbols: ['NIFTY'],
  symbol: 'NIFTY',
  date: '2026-11-13',
  expiry: { NIFTY: null },
  spotPrevClose: { NIFTY: 24_900 },
  spot: { NIFTY: [] },
  strikes: {},
  minuteCount: 0,
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchStrikeFlow', () => {
  it('requests the selected date and cursor without caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, payload));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    expect(await fetchStrikeFlow('NIFTY', { date: '2026-11-13', asOf: '0930', signal: controller.signal })).toEqual(payload);

    const [input, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(String(input), 'http://localhost');
    expect(url.pathname).toBe('/api/strikes/NIFTY');
    expect(url.searchParams.get('date')).toBe('2026-11-13');
    expect(url.searchParams.get('asOf')).toBe('0930');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBe(controller.signal);
  });

  it.each([404, 503])('returns an empty result for archive status %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status, { error: 'No captured chain.' })));

    await expect(fetchStrikeFlow('NIFTY', { date: '2026-11-13' })).resolves.toBeNull();
  });

  it('rejects unexpected HTTP errors and ignores malformed successful payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(500, { error: 'Internal error.' })));
    await expect(fetchStrikeFlow('NIFTY', { date: '2026-11-13' })).rejects.toThrow('Strike flow NIFTY: 500');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { symbols: ['NIFTY'], symbol: 'NIFTY' })));
    await expect(fetchStrikeFlow('NIFTY', { date: '2026-11-13' })).resolves.toBeNull();
  });

  it('keeps valid contracts when one strike row is malformed', async () => {
    const series: StrikeSeriesPoint[] = [[1_794_543_900_000, 100, 1_000, 10, 14.2], [1_794_543_960_000, 105, 1_100, 20, 14.8]];
    const valid: StrikeFlowContract = {
      symbol: 'NIFTY', strike: 25_150, side: 'CE', expiry: '2026-11-19', prevClose: 100, prevOi: 900,
      ltp: 105, oi: 1_100, volume: 20, iv: 14.8, spotDistancePct: 0.4, series,
    };
    const malformed = { ...valid, strike: Number.NaN, series: [[1_794_543_900_000, 'bad', null, null]] };
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      ...payload,
      expiry: { NIFTY: '2026-11-19' },
      spot: { NIFTY: [[1_794_543_900_000, 25_000]] },
      strikes: { 'NIFTY|25150|CE': valid, 'NIFTY|bad|PE': malformed },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchStrikeFlow('NIFTY', { date: '2026-11-13', force: true });

    expect(result?.strikes).toEqual({ 'NIFTY|25150|CE': valid });
  });

  it('remains compatible with older four-field premium series lacking captured IV', async () => {
    const oldContract = {
      symbol: 'NIFTY', strike: 25_150, side: 'CE', expiry: '2026-11-19', prevClose: 100, prevOi: 900,
      ltp: 105, oi: 1_100, volume: 20, spotDistancePct: 0.4,
      series: [[1_794_543_960_000, 105, 1_100, 20]],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
      ...payload,
      strikes: { 'NIFTY|25150|CE': oldContract },
    })));

    const result = await fetchStrikeFlow('NIFTY', { date: '2026-11-13', force: true });

    expect(result?.strikes['NIFTY|25150|CE']?.iv).toBeNull();
  });
});
