import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const underlyings = vi.hoisted(() => ({ load: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/underlyings', () => ({ loadUnderlyings: underlyings.load }));
vi.mock('@/features/market-flow/MarketFlowPage', () => ({ MarketFlowPage: ({ tabs }: { tabs?: ReactNode }) => <div>Order Flow canvas {tabs}</div> }));
vi.mock('@/features/strike-flow/StrikeFlowPage', () => ({ StrikeFlowPage: ({ tabs }: { tabs?: ReactNode }) => <div>Option Board canvas {tabs}</div> }));

import App from '@/App';

afterEach(cleanup);

describe('App flow tabs', () => {
  it('keeps Order Flow as the default and switches to Option Board, tabs inside each page bar', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Order Flow' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Order Flow canvas')).toBeInTheDocument();
    expect(screen.queryByText('Option Board canvas')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Option Board' }));

    expect(screen.getByRole('tab', { name: 'Option Board' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Option Board canvas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Order Flow' }));
    expect(screen.getByText('Order Flow canvas')).toBeInTheDocument();
  });
});
