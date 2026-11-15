import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Underlying } from '@/lib/underlyings';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint, StrikeSide } from './feed';

const feed = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./feed', () => ({ fetchStrikeFlow: feed.fetch }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/marketSession', () => ({
  getLatestTradingSessionDate: () => '2026-11-13',
  marketSessionBounds: () => ({ open: Date.parse('2026-11-13T03:45:00Z'), close: Date.parse('2026-11-13T10:10:00Z') }),
}));

import { StrikeFlowPage } from './StrikeFlowPage';

const BASE = Date.parse('2026-11-13T03:45:00Z');
const MINUTE = 60_000;

function contract(strike: number, side: StrikeSide, prices: number[], oi: number[]): StrikeFlowContract {
  const series: StrikeSeriesPoint[] = prices.map((ltp, index) => [BASE + index * MINUTE, ltp, oi[index], 10 + index]);
  const last = series.at(-1);
  return {
    strike,
    side,
    expiry: '2026-11-19',
    prevClose: 100,
    prevOi: 1_000,
    ltp: last?.[1] ?? null,
    oi: last?.[2] ?? null,
    volume: last?.[3] ?? null,
    spotDistancePct: 0,
    series,
  };
}

const fixture: StrikeFlowPayload = {
  symbol: 'NIFTY',
  date: '2026-11-13',
  expiry: '2026-11-19',
  spot: [[BASE, 25_000], [BASE + MINUTE, 25_010], [BASE + 2 * MINUTE, 25_020]],
  strikes: {
    '25150|CE': contract(25_150, 'CE', [100, 110, 112], [1_000, 1_100, 1_200]),
    '25000|PE': contract(25_000, 'PE', [100, 95, 90], [1_000, 1_050, 1_100]),
  },
  minuteCount: 3,
};

const universe = [
  { symbol: 'NIFTY', name: 'Nifty 50', apiKey: 'NSE:NIFTY50', lot: 65, kind: 'index', exch: 'NSE' },
  { symbol: 'RELIANCE', name: 'Reliance Industries', apiKey: 'NSE:RELIANCE', lot: 500, kind: 'stock', exch: 'NSE' },
] as Underlying[];

function page() {
  return render(<MemoryRouter><StrikeFlowPage universe={universe} /></MemoryRouter>);
}

beforeEach(() => {
  feed.fetch.mockReset();
  feed.fetch.mockResolvedValue(fixture);
});
afterEach(cleanup);

describe('StrikeFlowPage', () => {
  it('loads the latest trading date, ranks visible contracts, and filters by option side', async () => {
    page();

    await waitFor(() => expect(screen.getByText('NIFTY 2515C')).toBeInTheDocument());
    expect(feed.fetch).toHaveBeenCalledWith('NIFTY', expect.objectContaining({ date: '2026-11-13' }));
    expect(screen.getByText('NIFTY 2500PE')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'PE' }));

    expect(screen.getByText('NIFTY 2500PE')).toBeInTheDocument();
    expect(screen.queryByText('NIFTY 2515C')).not.toBeInTheDocument();
  });

  it('shows an honest empty state and retries the archive read', async () => {
    feed.fetch.mockResolvedValue(null);
    page();

    expect(await screen.findByRole('heading', { name: 'No captured chain for NIFTY on 2026-11-13' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry archive' }));
    await waitFor(() => expect(feed.fetch).toHaveBeenCalledTimes(2));
  });

  it('renders a request failure separately from an empty archive', async () => {
    feed.fetch.mockRejectedValue(new Error('transport failed'));
    page();

    expect(await screen.findByRole('heading', { name: 'Strike chain could not be loaded' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
