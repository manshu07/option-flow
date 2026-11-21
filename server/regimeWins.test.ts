import { describe, expect, it } from 'vitest';
import { buildRegimeWinsReport, outcomeBucket, printRegimeWinsReport, signalBucket } from './regimeWins.mjs';

describe('regime win cross-tab builder', () => {
  const fixture = () => {
    const buckets = [
      { early: 'momentum' },
      { early: 'build-fast' },
      { quality: 0.8 },
      { quality: 0.4 },
      { reEntry: 1 },
    ];
    const regimes = ['up', 'down', 'range', null];
    const outcomes = [
      { status: 'tgt1', r: 2 },
      { status: 'sl', r: -1 },
      { status: 'ambiguous', r: -0.5 },
      null,
      { status: 'custom', r: 0.25 },
    ];
    return buckets.flatMap((bucket, bucketIndex) => regimes.map((regime, regimeIndex) => ({
      id: `${bucketIndex}-${regimeIndex}`,
      symbol: `SYM${bucketIndex}${regimeIndex}`,
      date: `2026-11-${String(18 + regimeIndex).padStart(2, '0')}`,
      side: regimeIndex % 2 === 0 ? 'CE' : 'PE',
      regime,
      ...bucket,
      outcome: outcomes[(bucketIndex * regimes.length + regimeIndex) % outcomes.length],
    })));
  };

  it('cross-tabs every bucket, regime and outcome while preserving open/resolved counts', () => {
    const cards = fixture();
    const before = structuredClone(cards);
    const report = buildRegimeWinsReport(cards);

    expect(cards).toEqual(before);
    expect(report).toMatchObject({
      totalCards: 20,
      dateRange: { from: '2026-11-18', to: '2026-11-21' },
      bucketCounts: {
        'early-momentum': 4,
        'early-build-fast': 4,
        'model >=65': 4,
        'model <65': 4,
        're-entry': 4,
      },
    });
    expect(report.rows).toHaveLength(100);
    expect(report.rows.reduce((sum, row) => sum + row.cards, 0)).toBe(cards.length);
    expect(report.bucketRegime).toHaveLength(20);
    expect(report.regimeDirection).toHaveLength(12);
    expect(report.bucketRegime.reduce((sum, row) => sum + row.resolved, 0)).toBe(16);
    expect(report.bucketRegime.reduce((sum, row) => sum + row.open, 0)).toBe(4);
    expect(report.bucketRegime.reduce((sum, row) => sum + row.tgt1, 0)).toBe(4);
    expect(report.bucketRegime.reduce((sum, row) => sum + row.sl, 0)).toBe(4);
    expect(report.bucketRegime.reduce((sum, row) => sum + (row.netR ?? 0), 0)).toBe(3);
    expect(report.regimeDirection.reduce((sum, row) => sum + row.cards, 0)).toBe(cards.length);
    expect(report.regimeDirection.find(row => row.regime === 'range' && row.direction === 'CE')).toMatchObject({ cards: 5, resolved: 4, tgt1: 1, sl: 1 });
    expect(report.bucketRegime.find(row => row.bucket === 'early-momentum' && row.regime === 'up')).toMatchObject({ cards: 1, resolved: 1, tgt1: 1, winRate: 1, netR: 2 });
    expect(report.bucketRegime.find(row => row.bucket === 'model <65' && row.regime === 'unknown')).toMatchObject({ cards: 1, open: 0, resolved: 1, tgt1: 1, netR: 2 });
    expect(report.bucketRegime.find(row => row.bucket === 'early-momentum' && row.regime === 'unknown')).toMatchObject({ cards: 1, open: 1, resolved: 0, netR: null });
  });

  it('renders a compact console table and classifies missing fields deterministically', () => {
    const report = buildRegimeWinsReport([{ symbol: 'X', date: '2026-11-20', outcome: { status: 'open' } }]);
    const lines: string[] = [];
    printRegimeWinsReport(report, line => lines.push(line));
    expect(lines[0]).toContain('1 cards');
    expect(lines.some(line => line.includes('model <65') && line.includes('unknown') && line.includes('open'))).toBe(true);
    expect(signalBucket({ reEntry: 1, early: 'momentum' })).toBe('re-entry');
    expect(outcomeBucket({ outcome: { status: 'open' } })).toBe('open');
    expect(outcomeBucket({ outcome: { status: 'custom' } })).toBe('other');
  });
});
