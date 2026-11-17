import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservationsPage } from './ObservationsPage';
import type { ObservationFollowThrough } from './observationModel';

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
  outcome?: { status?: 'tgt1' | 'sl' | 'open' | 'ambiguous'; followThrough?: ObservationFollowThrough | null };
};
let responseCards: TestCard[];

const evidence = (overrides: Partial<ObservationFollowThrough> = {}): ObservationFollowThrough => ({
  version: 1,
  source: 'raw',
  from: Date.parse('2026-11-16T04:15:00Z'),
  sessionCloseAt: Date.parse('2026-11-16T10:10:00Z'),
  firstAt: Date.parse('2026-11-16T04:16:00Z'),
  lastAt: Date.parse('2026-11-16T10:10:00Z'),
  sampleCount: 355,
  expectedMinutes: 355,
  missingMinutes: 0,
  coverage: 'complete',
  range: { open: 100, high: 220, low: 80, close: 180 },
  touches: { sl: null, tgt1: null, tgt2: null },
  sequence: 'none-observed',
  ...overrides,
});

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
    expect(screen.getByText('Post-call verification').parentElement).toHaveTextContent('Recorded journal status: —');
    expect(screen.getByText('Post-call evidence unavailable; no sampled verification is attached.')).toBeInTheDocument();
  });

  it('renders complete evidence, TGT2, and the post-SL disclaimer without changing journal status', async () => {
    responseCards = [{ ...card, outcome: {
      status: 'sl',
      followThrough: evidence({
        touches: {
          sl: { at: Date.parse('2026-11-16T05:00:00Z'), after: Date.parse('2026-11-16T05:00:00Z'), source: 'ltp' },
          tgt1: { at: Date.parse('2026-11-16T06:00:00Z'), after: Date.parse('2026-11-16T06:00:00Z'), source: 'ltp' },
          tgt2: { at: Date.parse('2026-11-16T07:00:00Z'), after: Date.parse('2026-11-16T06:30:00Z'), source: 'day-range' },
        },
        sequence: 'sl-first',
      }),
    } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);

    expect(await screen.findByText('Post-call sampled O/H/L/C')).toBeInTheDocument();
    expect(screen.getByText('100.00 / 220.00 / 80.00 / 180.00')).toBeInTheDocument();
    expect(screen.getByText(/Highest target observed: TGT2/)).toBeInTheDocument();
    expect(screen.getByText(/Later target touches are post-SL price movement, not a successful trade/)).toBeInTheDocument();
    expect(screen.getByText(/Touch observed · capture 16-Nov 10:30 IST/)).toBeInTheDocument();
    expect(screen.getByText(/Touch observed · capture 16-Nov 11:30 IST/)).toBeInTheDocument();
    expect(screen.getByText(/Touch observed · range interval \(16-Nov 12:00 IST–16-Nov 12:30 IST\]/)).toBeInTheDocument();
    expect(screen.getByText('Post-call verification').parentElement).toHaveTextContent('Recorded journal status: SL');
  });

  it('labels partial and missing coverage as insufficient rather than a no-hit result', async () => {
    responseCards = [{ ...card, outcome: { status: 'open', followThrough: evidence({ coverage: 'partial', missingMinutes: 3, sampleCount: 352 }) } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findAllByText('Insufficient data')).toHaveLength(3);
    expect(screen.getByText(/Coverage is partial; 3 minute samples are missing/)).toBeInTheDocument();

    cleanup();
    responseCards = [{ ...card, outcome: { status: 'ambiguous', followThrough: evidence({ coverage: 'missing', missingMinutes: 355, sampleCount: 0, firstAt: null, lastAt: null }) } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findAllByText('Insufficient data')).toHaveLength(3);
    expect(screen.getByText(/Coverage is missing; 355 minute samples are missing/)).toBeInTheDocument();
  });

  it('states when SL and target order is ambiguous', async () => {
    responseCards = [{ ...card, outcome: { status: 'ambiguous', followThrough: evidence({
      touches: {
        sl: { at: card.at + 120_000, after: card.at + 60_000, source: 'day-range' },
        tgt1: { at: card.at + 120_000, after: card.at + 60_000, source: 'day-range' }, tgt2: null,
      },
      sequence: 'ambiguous',
    }) } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findByText('SL/target order unknown; do not infer trade outcome from touch order.')).toBeInTheDocument();
  });

  it('renders a safe fallback for invalid persisted capture times', async () => {
    responseCards = [{ ...card, outcome: { status: 'open', followThrough: evidence({ firstAt: 1e30 }) } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    expect(await screen.findByText('Post-call evidence unavailable; the saved report is invalid.')).toBeInTheDocument();
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

  it('exposes the same verification in the existing Status table cell', async () => {
    responseCards = [{ ...card, outcome: { status: 'tgt1', followThrough: evidence({ touches: { sl: null, tgt1: { at: card.at + 120_000, after: card.at + 120_000, source: 'ltp' }, tgt2: null } }) } }];
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const table = await screen.findByRole('table');
    const statusCell = within(table).getAllByRole('cell').at(-1);
    const details = statusCell?.querySelector('details');
    expect(details).not.toBeNull();
    fireEvent.click(details!.querySelector('summary')!);
    expect(details!.querySelector('.obs-verification__highest')).toHaveTextContent('Highest target observed: TGT1 (legacy journal status is unchanged).');
  });
});
