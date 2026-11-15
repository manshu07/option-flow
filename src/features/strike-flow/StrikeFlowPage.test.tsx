import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Underlying } from '@/lib/underlyings';
import type { StrikeFlowContract, StrikeFlowPayload, StrikeSeriesPoint, StrikeSide } from './feed';

const feed = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./feed', () => ({
  fetchStrikeFlow: feed.fetch,
  fetchStrikeFlows: (symbols: string[], options: { date: string }) =>
    Promise.all(symbols.map(symbol => feed.fetch(symbol, options).then((payload: StrikeFlowPayload | null) => payload ?? { symbols: [symbol], symbol, date: options.date, expiry: {}, spotPrevClose: {}, spot: {}, strikes: {}, minuteCount: 0 })))
      .then(payloads => ({ payloads, unavailableSymbols: [], failedSymbols: [] })),
}));
vi.mock('../market-flow/FlowBoard', () => ({
  FlowBoard: ({ flow, status }: { flow: { stocks: Array<{ symbol: string }> }; status?: ReactNode }) => (
    <div data-testid="flow-board">{status}{flow.stocks.map(stock => <span key={stock.symbol}>{stock.symbol}</span>)}</div>
  ),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/marketSession', () => ({
  getLatestTradingSessionDate: () => '2026-11-13',
  marketSessionBounds: () => ({ open: Date.parse('2026-11-13T03:45:00Z'), close: Date.parse('2026-11-13T10:10:00Z') }),
  isExpirySettled: () => false,
}));

import { StrikeFlowPage } from './StrikeFlowPage';

const BASE = Date.parse('2026-11-13T03:45:00Z');
const MINUTE = 60_000;

function contract(strike: number, side: StrikeSide, prices: number[], oi: number[]): StrikeFlowContract {
  const series: StrikeSeriesPoint[] = prices.map((ltp, index) => [BASE + index * MINUTE, ltp, oi[index], 10 + index]);
  const last = series.at(-1);
  return {
    symbol: 'NIFTY',
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

function payload(strikes: StrikeFlowContract[]): StrikeFlowPayload {
  return {
    symbols: ['NIFTY'],
    symbol: 'NIFTY',
    date: '2026-11-13',
    expiry: { NIFTY: '2026-11-19' },
    spotPrevClose: { NIFTY: 24_900 },
    spot: { NIFTY: [[BASE, 25_000], [BASE + MINUTE, 25_010], [BASE + 2 * MINUTE, 25_020]] },
    strikes: Object.fromEntries(strikes.map(item => [`${item.symbol}|${item.strike}|${item.side}`, item])),
    minuteCount: 3,
  };
}

const fixture = payload([
  contract(25_150, 'CE', [100, 110, 112], [1_000, 1_100, 1_200]),
  contract(25_000, 'PE', [100, 95, 90], [1_000, 1_050, 1_100]),
]);

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

describe('StrikeFlowPage (Option Board)', () => {
  it('fetches all three indices by default and hands the contracts to Order Flow\'s diagram', async () => {
    page();

    await waitFor(() => expect(feed.fetch).toHaveBeenCalledTimes(3));
    expect(feed.fetch).toHaveBeenCalledWith('NIFTY', expect.objectContaining({ date: '2026-11-13' }));
    expect(feed.fetch).toHaveBeenCalledWith('BANKNIFTY', expect.anything());
    expect(feed.fetch).toHaveBeenCalledWith('SENSEX', expect.anything());
    const diagram = await screen.findByTestId('flow-board');
    expect(diagram).toHaveTextContent('NIFTY25150CE');
    expect(diagram).toHaveTextContent('NIFTY25000PE');
  });

  it('fetches a single chain for a single-index scope', async () => {
    page();

    await waitFor(() => expect(screen.getByTestId('flow-board')).toBeInTheDocument());
    const before = feed.fetch.mock.calls.length;
    fireEvent.click(screen.getByRole('radio', { name: 'Nifty' }));

    await waitFor(() => expect(feed.fetch.mock.calls.length).toBeGreaterThan(before));
    expect(feed.fetch).toHaveBeenLastCalledWith('NIFTY', expect.objectContaining({ date: '2026-11-13' }));
  });

  it('filters the board by mode: Momentum Flow shows both sides, Calls and Puts one', async () => {
    page();

    const diagram = await screen.findByTestId('flow-board');
    expect(diagram).toHaveTextContent('NIFTY25150CE');
    expect(diagram).toHaveTextContent('NIFTY25000PE');

    fireEvent.click(screen.getByRole('radio', { name: 'Calls (Top)' }));
    expect(screen.getByTestId('flow-board')).toHaveTextContent('NIFTY25150CE');
    expect(screen.queryByTestId('flow-board')).not.toHaveTextContent('NIFTY25000PE');

    fireEvent.click(screen.getByRole('radio', { name: 'Put (Top)' }));
    expect(screen.getByTestId('flow-board')).toHaveTextContent('NIFTY25000PE');
    expect(screen.queryByTestId('flow-board')).not.toHaveTextContent('NIFTY25150CE');
  });

  it('shows the stock dropdown only on the F&O Stock Options chip and fetches the chosen stock', async () => {
    page();

    await screen.findByTestId('flow-board');
    expect(screen.queryByLabelText('F&O stocks')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'F&O Stock Options' }));
    const select = screen.getByLabelText('F&O stocks');
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'RELIANCE' } });
    await waitFor(() => expect(feed.fetch).toHaveBeenLastCalledWith('RELIANCE', expect.anything()));
    await screen.findByTestId('flow-board');
    expect(screen.getByTestId('flow-board')).toBeInTheDocument();
  });

  it('shows an honest empty state and retries the archive read', async () => {
    feed.fetch.mockResolvedValue(null);
    page();

    expect(await screen.findByRole('heading', { name: 'No captured chain for NIFTY + BANKNIFTY + SENSEX on 2026-11-13' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry archive' }));
    await waitFor(() => expect(feed.fetch).toHaveBeenCalledTimes(6));
  });

  it('opens the Contracts Screener tab as an honest coming-soon view', async () => {
    page();

    await screen.findByTestId('flow-board');
    fireEvent.click(screen.getByRole('radio', { name: 'Contracts Screener' }));

    expect(screen.getByRole('heading', { name: 'Contracts Screener' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Option Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Option Board' }));
    expect(screen.getByTestId('flow-board')).toBeInTheDocument();
  });

  it('renders a request failure separately from an empty archive', async () => {
    feed.fetch.mockRejectedValue(new Error('transport failed'));
    page();

    expect(await screen.findByRole('heading', { name: 'Option chain could not be loaded' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
