import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const feed = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('@/lib/underlyings', () => ({
  loadUnderlyings: async () => [
    { symbol: 'NIFTY', name: 'Nifty 50', apiKey: 'NSE:NIFTY50', lot: 65, kind: 'index', exch: 'NSE' },
    { symbol: 'BANKNIFTY', name: 'Nifty Bank', apiKey: 'NSE:NIFTYBANK', lot: 30, kind: 'index', exch: 'NSE' },
    { symbol: 'SENSEX', name: 'BSE Sensex', apiKey: 'BSE:SENSEX', lot: 10, kind: 'index', exch: 'BSE' },
  ],
}));
vi.mock('@/features/market-flow/MarketFlowPage', () => ({ MarketFlowPage: ({ tabs }: { tabs: any }) => <div>{tabs}<div data-testid="order-flow" /></div> }));
vi.mock('@/features/observations/ObservationsPage', () => ({ ObservationsPage: ({ tabs }: { tabs: any }) => <div>{tabs}<div data-testid="observations" /></div> }));
vi.mock('@/features/strike-flow/feed', () => ({
  fetchStrikeFlows: async (symbols: string[], options: unknown) => ({
    payloads: await Promise.all(symbols.map(symbol => feed.fetch(symbol, options))),
    unavailableSymbols: [],
    failedSymbols: [],
  }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

import App from './App';

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function payload(symbol: string) {
  const spot = 25_000;
  const at = Date.parse('2026-11-16T04:17:00Z');
  const point = [at, spot] as const;
  const priorPoint = [at - 60_000, spot - 10] as const;
  const contract = symbol === 'NIFTY' ? {
    symbol,
    strike: 25_000,
    side: 'CE' as const,
    expiry: '2026-11-16',
    prevClose: 90,
    prevOi: 900,
    ltp: 100,
    oi: 1_000,
    volume: 100,
    iv: 20,
    spotDistancePct: 0,
    series: [[priorPoint[0], 95, 900, 90, 20] as const, [point[0], 100, 1_000, 100, 20] as const],
  } : null;
  return {
    symbols: [symbol],
    symbol,
    date: '2026-11-16',
    expiry: { [symbol]: '2026-11-16' },
    spotPrevClose: { [symbol]: 24_900 },
    spot: { [symbol]: [priorPoint, point] },
    strikes: contract ? { [`${symbol}|25000|CE`]: contract } : {},
    minuteCount: 1,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/observations') return response({ cards: [] });
    return response({});
  }));
  feed.fetch.mockReset().mockImplementation(async (symbol: string) => payload(symbol));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Option Board navigation', () => {
  it('opens the captured-chain gamma overlay after clicking the app tab', async () => {
    render(<MemoryRouter><App /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('tab', { name: 'Option Board' }));

    await waitFor(() => expect(document.querySelector('.mf-board')).toBeInTheDocument());
    await waitFor(() => expect(feed.fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('img', { name: 'NIFTY net gamma exposure by strike' })).toBeInTheDocument();
    expect(screen.getByText(/Dealer positioning sign is an assumption/)).toBeInTheDocument();
  });
});
