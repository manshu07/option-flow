import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const underlyings = vi.hoisted(() => ({ load: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/underlyings', () => ({ loadUnderlyings: underlyings.load }));
vi.mock('@/features/market-flow/MarketFlowPage', () => ({ MarketFlowPage: ({ tabs }: { tabs?: ReactNode }) => <div>Order Flow canvas {tabs}</div> }));
vi.mock('@/features/strike-flow/StrikeFlowPage', () => ({ StrikeFlowPage: ({ tabs }: { tabs?: ReactNode }) => <div>Strike Flow canvas {tabs}</div> }));

import App from '@/App';

afterEach(cleanup);

describe('App flow tabs', () => {
  it('keeps Order Flow as the default and switches to Strike Flow, tabs inside each page bar', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Order Flow' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Order Flow canvas')).toBeInTheDocument();
    expect(screen.queryByText('Strike Flow canvas')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Strike Flow' }));

    expect(screen.getByRole('tab', { name: 'Strike Flow' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Strike Flow canvas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Order Flow' }));
    expect(screen.getByText('Order Flow canvas')).toBeInTheDocument();
  });
});
