import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservationsPage } from './ObservationsPage';

const card = {
  id: 'obs-nifty-25150',
  at: Date.parse('2026-11-16T04:15:00Z'),
  date: '2026-11-16',
  symbol: 'NIFTY',
  bias: 'bullish' as const,
  side: 'CE' as const,
  strike: 25_150,
  expiry: '2026-11-22',
  entry: 1003.2999877929688,
  sl: 551.8149932861328,
  tgt1: 1555.114990234375,
  tgt2: 1906.269989013672,
  tsl: 'after TGT1, trail the stop to entry (cost)',
  support: { strike: 25_100, oi: 2_500_000, changePct: 3.1415926 },
  resistance: { strike: 25_200, oi: 3_500_000, changePct: -1.234567 },
  quality: 0.8,
  strikePickProbability: 0.7,
  oiChangePct: 5,
  gamma: {
    gexAtStrike: 1_250_000,
    distanceToFlip: 0.44,
    regime: 'gamma-short' as const,
    flipLevel: 25_180,
    pin: '25250CE',
    notes: ['Wall-based stop sits beyond the gamma flip; dealers may accelerate the move.'],
  },
  disclaimer: 'Educational observation — not trade advice.',
};

type TestCard = Omit<typeof card, 'gamma'> & {
  gamma?: { gexAtStrike: number | null; distanceToFlip: number | null; regime: 'gamma-long' | 'gamma-short' | null; flipLevel: number | null; pin: string | null; notes: string[] } | null;
  outcome?: { status?: 'tgt1' | 'sl' | 'open' | 'ambiguous' };
};
let responseCards: TestCard[];

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T04:15:00Z'));
  responseCards = [card, { ...card, id: 'duplicate-id', entry: 999 }];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/observations') return Promise.resolve(jsonResponse({ cards: responseCards }));
    if (url === '/api/market') return Promise.resolve(jsonResponse({
      t: Date.parse('2026-11-16T04:15:00Z'),
      series: [{ s: 'NIFTY', sp: 1003.2999877929688, pc: 1_000 }],
    }));
    if (url === '/api/futures/NIFTY') return Promise.resolve(jsonResponse({ months: [{ candles: [] }] }));
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ObservationsPage cards and table', () => {
  it('shows dated expiry, timestamp age, plain dealer flow, theta, and formatted prices', async () => {
    const { container } = render(<MemoryRouter><ObservationsPage /></MemoryRouter>);

    expect(await screen.findByText('~1003.30')).toBeInTheDocument();
    expect(screen.getAllByText('1003.30').length).toBeGreaterThan(0);
    expect(screen.getByText('551.81')).toBeInTheDocument();
    expect(screen.getByText('1555.11')).toBeInTheDocument();
    expect(screen.getByText('1906.27')).toBeInTheDocument();
    expect(screen.queryByText('~999.00')).not.toBeInTheDocument();
    expect(screen.getByText(/3\.14%/)).toBeInTheDocument();
    expect(screen.getByText(/-1\.23%/)).toBeInTheDocument();
    expect(screen.getByText('25150CE · 22-Nov (6 DTE)')).toBeInTheDocument();
    expect(screen.getByText('16-Nov · 09:45 IST · 1d ago')).toBeInTheDocument();
    expect(screen.getByText('📐 Dealer flow: TREND below 25,180 — moves can accelerate · pin 25250CE')).toBeInTheDocument();
    expect(screen.getByText('⏳ 6 DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.')).toBeInTheDocument();
    expect(screen.getByText(/Wall-based stop sits beyond the dealer-flow level/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Γ regime');
    expect(container.textContent?.toLowerCase()).not.toContain('gamma');
    expect(screen.queryByText(/1003\.2999877929688/)).not.toBeInTheDocument();
    expect(container.querySelector('.observations__status')).toHaveTextContent('0 today · 1 saved history');
  });

  it('strengthens the theta line at two DTE and omits it at twenty DTE', async () => {
    responseCards = [{ ...card, expiry: '2026-11-18' }];
    const first = render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findByText('⏳ 2 DTE — expiry-week decay is brutal; treat as a same-day trade only.')).toBeInTheDocument();
    first.unmount();

    responseCards = [{ ...card, expiry: '2026-12-06' }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findByText('25150CE · 06-Dec (20 DTE)')).toBeInTheDocument();
    expect(screen.queryByText(/theta eats|expiry-week decay/)).not.toBeInTheDocument();
  });

  it('omits the dealer-flow sentence when the Gamma flip is unavailable', async () => {
    responseCards = [{ ...card, gamma: { ...card.gamma, flipLevel: null } }];
    const { container } = render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    await screen.findByText('25150CE · 22-Nov (6 DTE)');
    expect(container.textContent).not.toContain('Dealer flow:');
    expect(container.textContent).not.toContain('Γ regime');
  });

  it('renders ten newest cards per page in both views and remembers the table choice', async () => {
    responseCards = Array.from({ length: 21 }, (_, index) => ({
      ...card,
      id: `obs-${index}`,
      symbol: `SYM${String(index).padStart(2, '0')}`,
      at: card.at + index * 60_000,
      ...(index === 20 ? { outcome: { status: 'tgt1' as const } } : {}),
    }));
    const { unmount } = render(<MemoryRouter><ObservationsPage /></MemoryRouter>);

    expect(await screen.findByText('1–10 of 21')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(10);
    expect(screen.getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('SYM20');
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByText('11–20 of 21')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const table = await screen.findByRole('table');
    expect(screen.getByText('1–10 of 21')).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual([
      'Time', 'Symbol', 'Contract', 'Expiry', 'DTE', 'Bias', 'Quality', 'Entry', 'SL', 'TGT1', 'TGT2', 'Live opt', 'Flow', 'Status',
    ]);
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).getByText('16-Nov 10:05')).toBeInTheDocument();
    expect(within(table).getAllByText('Trend')).toHaveLength(10);
    expect(within(table).getAllByText('TGT1').length).toBeGreaterThan(1);
    expect(localStorage.getItem('observations-view:v1')).toBe('"table"');

    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByText('11–20 of 21')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Cards' }));
    expect(screen.getByText('1–10 of 21')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(10);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    unmount();
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
