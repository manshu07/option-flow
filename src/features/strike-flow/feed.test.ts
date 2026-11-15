import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrikeFlowPayload } from './feed';
import { fetchStrikeFlow } from './feed';

const payload: StrikeFlowPayload = {
  symbol: 'NIFTY',
  date: '2026-11-13',
  expiry: null,
  spot: [],
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { symbol: 'NIFTY' })));
    await expect(fetchStrikeFlow('NIFTY', { date: '2026-11-13' })).resolves.toBeNull();
  });
});
