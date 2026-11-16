import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateStrikes, chainWalls, levelsFor, advisorQuestions, advisorDecisions, loadObservations, runAdvisor } from './strikeAdvisor.mjs';

const NOW = Date.parse('2026-11-16T05:00:00Z');

function seriesFixture() {
  const rows: number[][] = [];
  // Strikes 290..310 step 5; CE side 0, PE side 1. [strike, side, ltp, prevClose, oi, prevOi, vol]
  for (const strike of [290, 295, 300, 305, 310]) {
    rows.push([strike, 0, 4 + (310 - strike) * 0.5, 5, strike === 310 ? 4_200_000 : 1_000_000, 3_500_000, 100_000]); // CE, 310 = resistance wall
    rows.push([strike, 1, 4 + (strike - 290) * 0.5, 5, strike === 290 ? 3_800_000 : 900_000, 900_000, 90_000]);   // PE, 290 = support wall
  }
  return { s: 'MANAPPURAM', sp: 300.4, pc: 308, atm: 300, e: '2026-11-19', r: rows, date: '2026-11-16' };
}

describe('candidateStrikes', () => {
  it('returns buy-side candidates around ATM on the bias side', () => {
    const series = seriesFixture();
    const bearish = candidateStrikes(series, 'bearish');
    expect(bearish.map(c => c.side)).toEqual([1, 1, 1]);
    expect(bearish[0].strike).toBe(300); // ATM first
    expect(bearish.map(c => c.strike)).toEqual([300, 295, 290]);
    const bullish = candidateStrikes(series, 'bullish');
    expect(bullish.map(c => c.strike)).toEqual([300, 305, 310]);
    expect(bullish.every(c => c.side === 0)).toBe(true);
  });

  it('drops near-zero premium candidates (no lottery strikes)', () => {
    const series = seriesFixture();
    series.r = series.r.map(r => (r[0] === 290 && r[1] === 1 ? [290, 1, 0.1, 5, 3_800_000, 900_000, 1] : r));
    const strikes = candidateStrikes(series, 'bearish').map(c => c.strike);
    expect(strikes).not.toContain(290);
  });

  it('returns nothing without spot/atm', () => {
    expect(candidateStrikes({ sp: null }, 'bullish')).toEqual([]);
  });
});

describe('chainWalls / levelsFor', () => {
  it('finds heaviest CE above spot and PE below spot', () => {
    const walls = chainWalls(seriesFixture());
    expect(walls.resistance?.strike).toBe(310);
    expect(walls.support?.strike).toBe(290);
  });

  it('computes the card numbers from the entry premium only', () => {
    const levels = levelsFor({ ltp: 4 }, chainWalls(seriesFixture()));
    expect(levels.entry).toBe(4);
    expect(levels.sl).toBe(2.2);   // −45%
    expect(levels.tgt1).toBe(6.2); // +55%
    expect(levels.tgt2).toBe(7.6); // +90%
    expect(levels.support?.strike).toBe(290);
    expect(levels.resistance?.strike).toBe(310);
  });
});

describe('advisorQuestions / advisorDecisions', () => {
  const candidates = candidateStrikes(seriesFixture(), 'bearish');
  const watch = { symbol: 'MANAPPURAM', bias: 'bearish', candidates, walls: chainWalls(seriesFixture()), at: NOW, date: '2026-11-16' };

  it('asks one quality Noul and one strike Choice per symbol', () => {
    const questions = advisorQuestions('MANAPPURAM', 'bearish', candidates);
    expect(Object.keys(questions)).toEqual(['quality_MANAPPURAM', 'strike_MANAPPURAM']);
    expect(questions.strike_MANAPPURAM.criteria.c1.strike).toBe(300);
  });

  it('writes a card at quality ≥0.7 with a decisive pick', () => {
    const answers = { quality_MANAPPURAM: { noul: 0.8 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.75, c2: 0.15, c3: 0.1 } } };
    const { cards, skipped } = advisorDecisions([watch], answers);
    expect(skipped).toHaveLength(0);
    expect(cards[0].side).toBe('PE');
    expect(cards[0].strike).toBe(300);
    expect(cards[0].sl).toBeLessThan(cards[0].entry);
    expect(cards[0].tgt2).toBeGreaterThan(cards[0].tgt1);
    expect(cards[0].disclaimer).toMatch(/not trade advice/);
  });

  it('skips on low quality or an indecisive pick', () => {
    const low = advisorDecisions([watch], { quality_MANAPPURAM: { noul: 0.4 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } });
    expect(low.cards).toHaveLength(0);
    const unsure = advisorDecisions([watch], { quality_MANAPPURAM: { noul: 0.9 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.34, c2: 0.33, c3: 0.33 } } });
    expect(unsure.cards).toHaveLength(0);
  });
});

describe('runAdvisor gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const obsPath = join(dir, 'observations.json');
  const prepared = [{ symbol: 'MANAPPURAM', bias: 'bearish', candidates: [{ id: 'c1', strike: 300, side: 1, ltp: 4, oi: 1_000_000, prevOi: 900_000, oiChangePct: 11 }], walls: {}, at: NOW, date: '2026-11-16' }];

  it('skips outside the fire window without asking', async () => {
    const result = await runAdvisor({ date: '2026-11-16', series: [] }, { obsPath, watches: prepared, now: Date.parse('2026-11-16T03:50:00Z'), ask: async () => { throw new Error('must not be called'); } });
    expect(result.skipped).toBe('outside fire window');
  });

  it('surfaces a Jev failure as a skip and keeps the store intact', async () => {
    writeFileSync(obsPath, JSON.stringify({ cards: [{ id: 'old' }] }));
    const result = await runAdvisor({ date: '2026-11-16', series: [seriesFixture()] }, { obsPath, watches: prepared, now: NOW, ask: async () => { throw new Error('HTTP 503'); } });
    expect(result.skipped).toBe('failed');
    expect(loadObservations(obsPath)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
