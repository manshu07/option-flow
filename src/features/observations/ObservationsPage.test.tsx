import { cleanup, render, screen } from '@testing-library/react';
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
  expiry: '2026-11-19',
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

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
}

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/observations') return Promise.resolve(jsonResponse({ cards: [card, { ...card, id: 'duplicate-id', entry: 999 }] }));
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
});

describe('ObservationsPage price formatting', () => {
  it('shows live, entry, stop, target, and wall prices to exactly two decimals', async () => {
    render(<MemoryRouter><ObservationsPage /></MemoryRouter>);

    expect(await screen.findByText('~1003.30')).toBeInTheDocument();
    expect(screen.getAllByText('1003.30').length).toBeGreaterThan(0);
    expect(screen.getByText('551.81')).toBeInTheDocument();
    expect(screen.getByText('1555.11')).toBeInTheDocument();
    expect(screen.getByText('1906.27')).toBeInTheDocument();
    expect(screen.queryByText('~999.00')).not.toBeInTheDocument();
    expect(screen.getByText(/3\.14%/)).toBeInTheDocument();
    expect(screen.getByText(/-1\.23%/)).toBeInTheDocument();
    expect(screen.getByText('Γ regime: short · flip 25180 · pin 25250CE')).toBeInTheDocument();
    expect(screen.getByText(/Wall-based stop sits beyond the gamma flip/)).toBeInTheDocument();
    expect(screen.queryByText(/1003\.2999877929688/)).not.toBeInTheDocument();
  });
});
