import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GammaProfile } from '../market-flow/gammaModel';
import { GammaOverlay, GammaRegimeChips, type GammaProfileView } from './GammaOverlay';

const profile: GammaProfile = {
  strikes: [
    { K: 25_100, side: 'PE', iv: 0.18, ivSource: 'feed', gamma: 0.1, gex: -10, oi: 1000 },
    { K: 25_150, side: 'CE', iv: 0.18, ivSource: 'feed', gamma: 0.3, gex: 40, oi: 2000 },
    { K: 25_200, side: 'CE', iv: 0.18, ivSource: 'inverted', gamma: 0.25, gex: 30, oi: 1500 },
    { K: 25_250, side: 'CE', iv: 0.18, ivSource: 'feed', gamma: 0.2, gex: 20, oi: 1000 },
  ],
  skipped: 2,
  totalGex: 80,
  flipLevel: 25_200,
  regime: 'gamma-long',
};

const view: GammaProfileView = { symbol: 'NIFTY', spot: 25_210, profile };

describe('Option Board gamma overlay', () => {
  it('shows signed GEX bars, heaviest strikes, flip level, regime, and assumption disclaimer', () => {
    render(<><GammaRegimeChips profiles={[view]} /><GammaOverlay profiles={[view]} /></>);

    expect(screen.getByText('NIFTY RANGE · dips bought, breakouts fade')).toBeInTheDocument();
    expect(screen.getByTitle('Gamma Long')).toBeInTheDocument();
    const chart = screen.getByRole('img', { name: 'NIFTY net gamma exposure by strike' });
    expect(within(chart).getByText('FLIP 25200')).toBeInTheDocument();
    expect(chart.querySelectorAll('.gamma-overlay__strike-label')).toHaveLength(3);
    expect(screen.getByText(/Dealer positioning sign is an assumption/)).toBeInTheDocument();
  });

  it('keeps the exact flip label when ATR is missing', () => {
    render(<GammaOverlay profiles={[view]} />);
    expect(screen.getByRole('img', { name: 'NIFTY net gamma exposure by strike' })).toHaveTextContent('FLIP 25200');
    expect(screen.getByRole('img', { name: 'NIFTY net gamma exposure by strike' })).not.toHaveTextContent('ATR');
  });

  it('hides the overlay and chip silently when there are no eligible strikes', () => {
    const empty: GammaProfileView = { symbol: 'BANKNIFTY', spot: 50_000, profile: { ...profile, strikes: [] } };
    const { container } = render(<><GammaRegimeChips profiles={[empty]} /><GammaOverlay profiles={[empty]} /></>);
    expect(container.firstChild).toBeNull();
  });
});
