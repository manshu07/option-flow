import { describe, expect, it } from 'vitest';
import { lastFiveTradingDates, weeklyReviewDue, weeklyReviewMessage } from './weeklyReview.mjs';

const FRIDAY = Date.parse('2026-11-20T10:20:00Z'); // 15:50 IST

describe('Friday weekly observation review', () => {
  it('selects the latest five trading sessions and gates delivery to Friday 15:50', () => {
    expect(lastFiveTradingDates(FRIDAY)).toEqual([
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20',
    ]);
    expect(weeklyReviewDue(FRIDAY)).toBe('2026-11-20');
    expect(weeklyReviewDue(FRIDAY, '2026-11-20')).toBeNull();
    expect(weeklyReviewDue(Date.parse('2026-11-20T10:19:00Z'))).toBeNull();
    expect(weeklyReviewDue(Date.parse('2026-11-19T10:20:00Z'))).toBeNull();
  });

  it('reports cards, outcomes, scored average, and deterministic best/worst without quality values', () => {
    const message = weeklyReviewMessage([
      { date: '2026-11-16', symbol: 'TMPV', strike: 265, side: 'PE', quality: 0.99, outcome: { status: 'tgt1', r: 1.22 } },
      { date: '2026-11-17', symbol: 'BANKNIFTY', strike: 61600, side: 'CE', quality: 0.9, outcome: { status: 'sl', r: -1 } },
      { date: '2026-11-18', symbol: 'MANAPPURAM', strike: 305, side: 'PE', outcome: { status: 'open', r: null } },
      { date: '2026-11-19', symbol: 'NIFTY', strike: 25000, side: 'CE', outcome: { status: 'ambiguous', r: -1 } },
      { date: '2026-11-20', symbol: 'SONACOMS', strike: 920, side: 'CE' },
      { date: '2026-11-13', symbol: 'OUTSIDE', strike: 100, side: 'CE', outcome: { status: 'tgt1', r: 10 } },
    ], FRIDAY);

    expect(message).toContain('Cards written 5 · resolved 4');
    expect(message).toContain('TGT1 1 · SL 2 (includes 1 ambiguous) · open 1');
    expect(message).toContain('Average R −0.26 across 3 scored outcomes');
    expect(message).toContain('Best TMPV 265PE R+1.22');
    expect(message).toContain('Worst BANKNIFTY 61600CE R−1.00');
    expect(message).not.toContain('0.99');
    expect(message).not.toContain('OUTSIDE');
  });

  it('skips the review when fewer than three cards have resolved outcomes', () => {
    expect(weeklyReviewMessage([
      { date: '2026-11-20', symbol: 'TMPV', strike: 265, side: 'PE', outcome: { status: 'open', r: null } },
      { date: '2026-11-19', symbol: 'NIFTY', strike: 25000, side: 'CE' },
    ], FRIDAY)).toBeNull();
  });
});
