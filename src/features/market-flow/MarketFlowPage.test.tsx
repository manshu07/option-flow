import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Underlying } from '@/lib/underlyings';
import type { MarketFlow } from './marketFlowModel';

const media = vi.hoisted(() => ({ wide: false, phone: false }));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => (query.includes('min-width: 1100px') ? media.wide : query.includes('max-width: 768px') ? media.phone : false),
}));
const hook = vi.hoisted(() => ({ flow: null as MarketFlow | null, universe: [] as string[] }));
vi.mock('./useMarketFlow', () => ({
  useMarketFlow: (universe: Array<{ symbol: string }>) => (hook.universe = universe.map(item => item.symbol), { flow: hook.flow, market: hook.flow ? { at: Date.parse(`${hook.flow.date}T10:15:00+05:30`), date: hook.flow.date } : null, loading: !hook.flow, error: null, provider: null, futuresRead: 0, futuresTotal: 0, session: null, rescan: () => undefined }),
}));
const replay = vi.hoisted(() => ({ date: '', requested: false }));
vi.mock('./useReplayFlow', () => ({
  useReplayFlow: (_universe: unknown, _settings: unknown, options: { requested: boolean; date: string }) => {
    replay.date = options.date;
    replay.requested = options.requested;
    return { active: options.requested, flow: options.requested ? hook.flow : null, market: null, loading: false, error: null, provider: null, futuresRead: 0, futuresTotal: 0, notice: null, cursorLabel: '09:15', manifest: null, mode: { mode: options.requested ? 'replay' : 'live', playing: false, cursorIndex: 0 }, togglePlay: () => undefined, seek: () => undefined, goLive: () => undefined, retry: () => undefined };
  },
}));

import { MarketFlowPage } from './MarketFlowPage';

const empty: MarketFlow = {
  asOf: 0, date: '2026-10-09', window: 'day', floorPct: 0.5, stocks: [], sectors: [], bullish: [], bearish: [], rangebound: [], unread: [],
  buckets: { LONG_BUILD: [], SHORT_BUILD: [], SHORT_COVER: [], LONG_UNWIND: [] }, featured: { bullish: [], bearish: [] },
  futures: { read: 0, unavailable: 0, failed: 0, pending: 0, total: 0, latestAt: null }, provisional: false,
};
const nifty = { symbol: 'NIFTY', name: 'Nifty 50', apiKey: 'NSE:NIFTY50', lot: 65, kind: 'index', exch: 'NSE' } as Underlying;
const reliance = { symbol: 'RELIANCE', name: 'Reliance', apiKey: 'NSE:RELIANCE', lot: 500, kind: 'stock', exch: 'NSE' } as Underlying;
const suzlon = { symbol: 'SUZLON', name: 'Suzlon', apiKey: 'NSE:SUZLON', lot: 8000, kind: 'stock', exch: 'NSE' } as Underlying;
const page = (universe: Underlying[] = []) => render(<MemoryRouter><MarketFlowPage universe={universe} /></MemoryRouter>);

beforeEach(() => { localStorage.clear(); media.wide = false; media.phone = false; hook.flow = empty; });
afterEach(cleanup);

describe('MarketFlowPage', () => {
  it('lays out by the media queries: one surface on a desktop, stacked on a tablet, panels on a phone', () => {
    media.wide = true;
    const view = page();
    expect(view.container.querySelector('.ui-flow')).toHaveAttribute('data-layout', 'desktop');
    expect(view.container.querySelector('.mf-board[data-layout="desktop"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: /^Bullish/ })).toBeInTheDocument();
    cleanup();
    media.wide = false;
    const tablet = page();
    expect(tablet.container.querySelector('.ui-flow')).toHaveAttribute('data-layout', 'tablet');
    expect(screen.getByRole('region', { name: /^Bearish/ })).toBeInTheDocument();
    cleanup();
    media.phone = true;
    const phone = page();
    expect(phone.container.querySelector('.ui-flow')).toHaveAttribute('data-layout', 'phone');
    expect(screen.queryByRole('region', { name: /^Bullish/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Bullish/ }));
    expect(screen.getByRole('region', { name: /^Bullish/ })).toBeInTheDocument();
  });

  it('offers only the universe switch, Nifty 50 or All F&O, and remembers it', () => {
    page([nifty, reliance, suzlon]);
    expect(screen.queryByRole('button', { name: 'Customise Order Flow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^1h$/ })).not.toBeInTheDocument();
    expect(hook.universe).toEqual(['NIFTY', 'RELIANCE', 'SUZLON']);
    fireEvent.click(screen.getByRole('radio', { name: 'Nifty 50' }));
    // NIFTY stays: it is the chart's reference line.
    expect(hook.universe).toEqual(['NIFTY', 'RELIANCE']);
    expect(localStorage.getItem('orderFlow:universe:v1')).toBe('nifty50');
  });

  it('keeps NSE and BSE separate: the BSE view carries only BSE underlyings and hides the Nifty 50 switch', () => {
    const sensex = { symbol: 'SENSEX', name: 'Sensex', apiKey: 'BSE:SENSEX', lot: 20, kind: 'index', exch: 'BSE' } as Underlying;
    const view = page([nifty, reliance, sensex]);
    expect(hook.universe).toEqual(['NIFTY', 'RELIANCE']);
    expect(view.container.querySelector('.ui-flow')).toHaveAttribute('data-exchange', 'NSE');

    fireEvent.click(screen.getByRole('radio', { name: 'BSE' }));
    expect(hook.universe).toEqual(['SENSEX']);
    expect(localStorage.getItem('orderFlow:exchange:v1')).toBe('BSE');
    expect(view.container.querySelector('.ui-flow')).toHaveAttribute('data-exchange', 'BSE');
    expect(screen.queryByRole('radio', { name: 'Nifty 50' })).not.toBeInTheDocument();
  });

  it('keeps an open replay pinned to the session where it was opened', () => {
    hook.flow = { ...empty, date: '2026-10-09' };
    const view = page([nifty]);
    fireEvent.click(screen.getByTestId('flow-replay-open'));
    expect(replay).toMatchObject({ date: '2026-10-09', requested: true });

    hook.flow = { ...empty, date: '2026-10-12' };
    view.rerender(<MemoryRouter><MarketFlowPage universe={[nifty]} /></MemoryRouter>);
    expect(replay).toMatchObject({ date: '2026-10-09', requested: true });
  });

  it('draws the empty board as a skeleton with the progress in words while nothing is read', () => {
    hook.flow = null;
    media.wide = true;
    const { container } = page();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the market…');
    expect(container.querySelectorAll('.mf-half.is-skeleton')).toHaveLength(2);
  });

});
