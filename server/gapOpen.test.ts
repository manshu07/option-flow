import { describe, expect, it } from 'vitest';
import { gapOpenDue, gapOpenMessage } from './gapOpen.mjs';

const GAP_AT = Date.parse('2026-11-16T03:50:00Z'); // 09:20 IST

describe('09:20 gap-open alert', () => {
  it('is due only once during the 09:20 IST minute on a trading day', () => {
    expect(gapOpenDue(GAP_AT)).toBe('2026-11-16');
    expect(gapOpenDue(GAP_AT + 60_000)).toBeNull();
    expect(gapOpenDue(GAP_AT, '2026-11-16')).toBeNull();
    expect(gapOpenDue(Date.parse('2026-11-16T03:49:00Z'))).toBeNull();
    expect(gapOpenDue(Date.parse('2026-11-15T03:50:00Z'))).toBeNull(); // Sunday
  });

  it('combines qualifying captured index gaps into one educational message', () => {
    const text = gapOpenMessage({
      date: '2026-11-16',
      series: [
        { s: 'NIFTY', sp: 25_396.44, pc: 25_144 }, // +1.0%
        { s: 'BANKNIFTY', sp: 49_500, pc: 50_000 }, // -1.0%
        { s: 'SENSEX', sp: 100_400, pc: 100_000 }, // inside threshold
        { s: 'TMPV', sp: 200, pc: 100 }, // not an index
      ],
    }, '2026-11-16');

    expect(text).toContain('<b>NIFTY</b> gap-up +1.0% vs Friday close 25144');
    expect(text).toContain('<b>BANKNIFTY</b> gap-down −1.0% vs Friday close 50000');
    expect(text).not.toContain('SENSEX');
    expect(text).not.toContain('TMPV');
    expect(text).toContain('09:20 IST');
  });

  it('silently skips missing or incomplete captured prices', () => {
    expect(gapOpenMessage(null, '2026-11-16')).toBeNull();
    expect(gapOpenMessage({ series: [{ s: 'NIFTY', sp: 25_000, pc: null }] }, '2026-11-16')).toBeNull();
    expect(gapOpenMessage({ series: [{ s: 'NIFTY', sp: 25_100, pc: 25_000 }] }, '2026-11-16')).toBeNull();
  });
});
