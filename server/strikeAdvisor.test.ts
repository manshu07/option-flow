import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateStrikes, chainWalls, chooseChain, orbStrategy, earlyCards, adaptiveLevels, levelsFor, advisorQuestions, advisorDecisions, createSectorCardBudget, dedupeObservations, loadObservations, observationKey, runAdvisor, saveObservations } from './strikeAdvisor.mjs';
import { observationCaption } from './observationCardSvg.mjs';
import { gammaProfile } from '../src/features/market-flow/gammaModel';

const NOW = Date.parse('2026-11-16T05:00:00Z');

afterEach(() => vi.unstubAllEnvs());

function seriesFixture() {
  const rows: number[][] = [];
  // Strikes 290..310 step 5; CE side 0, PE side 1. [strike, side, ltp, prevClose, oi, prevOi, vol]
  for (const strike of [290, 295, 300, 305, 310]) {
    rows.push([strike, 0, 4 + (310 - strike) * 0.5, 5, strike === 310 ? 4_200_000 : 1_000_000, 3_500_000, 100_000]); // CE, 310 = resistance wall
    rows.push([strike, 1, 4 + (strike - 290) * 0.5, 5, strike === 290 ? 3_800_000 : 900_000, 900_000, 90_000]);   // PE, 290 = support wall
  }
  return { s: 'MANAPPURAM', sp: 300.4, pc: 308, atm: 300, e: '2026-11-19', r: rows, date: '2026-11-16' };
}

describe('levels and keys', () => {
  it('snaps computed levels to the ₹0.05 tape grid', () => {
    const levels = levelsFor({ ltp: 9.47, delta: 0.4 }, { support: null, resistance: null });
    expect(levels.entry).toBe(9.47);
    expect(levels.sl).toBe(5.2);
    expect(levels.tgt1).toBe(14.7);
    expect(levels.tgt2).toBe(18);
    // Already-grid values pass through untouched.
    expect(levelsFor({ ltp: 5.35, delta: 0.3 }, { support: null, resistance: null }).sl).toBe(2.95);
  });

  it('observationKey separates re-entry cards from the original', () => {
    expect(observationKey({ symbol: 'X', date: '2026-11-19' })).toBe('X|2026-11-19');
    expect(observationKey({ symbol: 'X', date: '2026-11-19', reEntry: 1 })).toBe('X|2026-11-19:re1');
  });

  it('store write keeps an original SL card beside its re-entry when resolved history is capped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-reentry-store-'));
    const obsPath = join(dir, 'observations.json');
    const date = '2026-11-23';
    const original = { id: `BANKNIFTY|${date}`, symbol: 'BANKNIFTY', date, entry: 243, sl: 200, tgt1: 300, outcome: { status: 'sl', r: -1 } };
    const oldResolved = Array.from({ length: 4 }, (_, index) => ({
      id: `OLD${index}|${date}`, symbol: `OLD${index}`, date, entry: 10, sl: 5, tgt1: 15, outcome: { status: 'sl', r: -1 },
    }));
    const reEntry = { ...original, id: `BANKNIFTY|${date}:re1`, at: 2, reEntry: 1, outcome: { status: 'open', r: null } };
    try {
      const stored = saveObservations(obsPath, [...oldResolved, original, reEntry], 2);
      expect(stored).toHaveLength(2);
      const reread = loadObservations(obsPath);
      expect(reread).toHaveLength(2);
      expect(reread.find(card => !card.reEntry)).toMatchObject({ id: original.id, outcome: { status: 'sl', r: -1 } });
      expect(reread.find(card => card.reEntry === 1)).toMatchObject({ id: reEntry.id, outcome: { status: 'open', r: null } });
      expect(new Set(reread.map(observationKey))).toEqual(new Set([original.id, reEntry.id]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('candidateStrikes', () => {
  it('skips dust strikes and wide spreads, and derives ATR/delta levels', () => {
    const row18 = (strike: number, side: number, ltp: number, bid: number, ask: number, oi: number, volume: number, delta: number) => [
      strike, side, ltp, ltp, oi, oi, volume, 0, ltp, 20, bid, ask, 100, 100, ltp, ltp, null, delta,
    ];
    const series = {
      s: 'TEST', sp: 300, pc: 300, atm: 300, e: '2026-11-19',
      r: [
        row18(300, 0, 10, 1, 20, 500_000, 50_000, 0.5), // wide spread → skipped
        row18(305, 0, 8, 7.95, 8.05, 400_000, 40_000, 0.4), // liquid → candidate
        row18(310, 0, 6, 5.9, 6.1, 5_000, 40_000, 0.3), // OI too thin → skipped
        row18(295, 0, 12, 11.9, 12.1, 400_000, 100, 0.6), // volume too thin → skipped
      ],
    };
    const candidates = candidateStrikes(series, 'bullish');
    expect(candidates.map(item => item.strike)).toEqual([305]);
    expect(candidates[0].delta).toBe(0.4);

    const card = { entry: 50, atr: { value: 100, barMinutes: 15, state: 'normal' }, delta: 0.6 };
    expect(adaptiveLevels(card)).toMatchObject({ sl: 25, tgt1: 140, tgt2: 200, levelsBasis: 'ATR' });
    expect(adaptiveLevels({ entry: 50 })).toMatchObject({ levelsBasis: 'fixed' });
  });

  it('uses a sane index premium fallback when the computed stop/target degenerates', () => {
    const card = {
      symbol: 'NIFTY', side: 'CE', strike: 25_000, spot: 24_999.8, entry: 243, delta: 0.54, iv: 40.4,
      expiry: '2026-11-23', atr: { value: 500, barMinutes: 15, state: 'normal' },
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-18T15:30:00+05:30') });
    expect(priced.levelsBasis).toBe('index-fixed-sane');
    expect(priced.sl).toBeGreaterThan(priced.entry * 0.05);
    expect(priced.tgt1).toBeLessThan(priced.entry * 3);
    expect(priced.tgt1).toBeGreaterThan(priced.entry);
    expect(priced.sl).toBeLessThan(priced.entry);
    expect(priced.needs?.tgt1?.level).toBeGreaterThan(card.spot);
    expect(priced.needs?.sl?.level).toBeLessThan(card.spot);
    expect(priced.needs?.tgt1?.pct).toBeGreaterThan(0);
    expect(priced.requiredMovePct).toBeGreaterThan(0);
  });

  it('prefers the index underlying percentiles when they yield sane premium levels', () => {
    const at = Date.parse('2026-11-23T10:30:00+05:30');
    const card = {
      symbol: 'NIFTY', side: 'CE', strike: 1000, spot: 1000,
      entry: 7.618032194494049, delta: 0.5, iv: 15, expiry: '2026-11-28', date: '2026-11-23', at,
      atr: { value: 500, barMinutes: 15, state: 'expanded' },
    };
    const recent = { p10: 0.5, p20: 1, p30: 10, p50: 3, p70: 7.5, p85: 8, p95: 12, n: 700 };
    const moveStats = {
      instrument: 'INDEX', holds: [2], entryTimes: ['10:30'], recentCloses: Array(20).fill(1000),
      daily: { 2: { recent: { up: recent, down: recent } } },
    };
    const priced = adaptiveLevels(card, { now: at, holdDays: 2, moveStats });

    expect(priced.levelsBasis).toBe('index-percentile-fallback');
    expect(priced.history.targetPct).toBe(1);
    expect(priced.history.adversePct).toBe(1);
    expect(priced.sl).toBeGreaterThanOrEqual(card.entry * 0.05);
    expect(priced.sl).toBeLessThan(card.entry);
    expect(priced.tgt1).toBeGreaterThan(card.entry);
    expect(priced.tgt1).toBeLessThanOrEqual(card.entry * 3);
    expect(priced.needs.sl.level).toBeLessThan(card.spot);
    expect(priced.needs.tgt1.level).toBeGreaterThan(card.spot);
  });

  it('sizes levels from the stock\'s own history when move stats exist, and reports the reach rate', () => {
    const stats = {
      instrument: 'EQ', entryTimes: ['09:30', '14:30'], holds: [1, 2, 5],
      intraday: {},
      daily: {
        2: { recent: {
          up: { n: 713, p30: 0.6, p50: 1.16, p70: 1.89, p85: 2.82, p95: 4.56 },
          down: { n: 713, p30: 0.58, p50: 1.14, p70: 1.85, p85: 2.75, p95: 4.4 },
        } },
      },
    };
    const card = {
      symbol: 'TITAN', side: 'PE', strike: 4700, spot: 4648, entry: 121.25, delta: -0.5, iv: 22,
      expiry: '2026-12-29', at: Date.parse('2026-11-18T10:00:00+05:30'),
      atr: { value: 3.4, barMinutes: 15, state: 'normal' },
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-18T15:30:00+05:30'), moveStats: stats });
    expect(priced.levelsBasis).toBe('history+decay');
    expect(priced.history.instrument).toBe('EQ');
    expect(priced.history.samples).toBe(713);
    // TGT1 asks for the p30 move (reached by ~70% of past 2-day windows).
    expect(priced.history.targetPct).toBe(0.58);
    expect(priced.needs.tgt1.level).toBeLessThan(4648); // a PE needs the stock lower
    expect(priced.history.reach.tgt1).toBeGreaterThan(0.6);
    expect(priced.history.reach.tgt2).toBeLessThan(priced.history.reach.tgt1);
    expect(priced.tgt1).toBeGreaterThan(priced.entry);
    expect(priced.sl).toBeLessThan(priced.entry);
  });

  it('sizes from history even when the futures ATR has not warmed up', () => {
    const stats = {
      instrument: 'EQ', entryTimes: ['09:30'], holds: [1, 2],
      intraday: {},
      daily: { 2: { recent: {
        up: { n: 700, p30: 0.6, p50: 1.1, p70: 1.9, p85: 2.8, p95: 4.5 },
        down: { n: 700, p30: 0.58, p50: 1.1, p70: 1.85, p85: 2.75, p95: 4.4 },
      } } },
    };
    const card = {
      symbol: 'IREDA', side: 'CE', strike: 128, spot: 126.89, entry: 1.85, delta: 0.35, iv: 45,
      expiry: '2026-12-29', at: Date.parse('2026-11-19T10:32:00+05:30'), date: '2026-11-19',
      atr: null, // "futures line warming up…"
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-19T10:32:00+05:30'), moveStats: stats });
    expect(priced.levelsBasis).toBe('history+decay');
    expect(priced.needs?.tgt1?.level).toBeGreaterThan(126.89);
    expect(Number.isFinite(priced.tgt1)).toBe(true);
    // The same card on the weekly leg: decay eats the move, so it says so
    // instead of falling back to the old fixed percentages.
    const weekly = adaptiveLevels({ ...card, expiry: '2026-11-23' }, { holdDays: 2, now: Date.parse('2026-11-19T10:32:00+05:30'), moveStats: stats });
    expect(['decay-too-heavy', 'history+decay']).toContain(weekly.levelsBasis);
    expect(weekly.levelsBasis).not.toBe('fixed');
  });

  it('refuses to quote a premium target when decay eats an ATR-sized move', () => {
    const card = {
      symbol: 'X', side: 'CE', strike: 100, spot: 100, entry: 0.6, delta: 0.2, iv: 60,
      expiry: '2026-11-19', atr: { value: 0.02, barMinutes: 15, state: 'compressed' },
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-18T15:30:00+05:30') });
    expect(priced.levelsBasis).toBe('decay-too-heavy');
    expect(priced.needs).toBeNull();
  });

  it('early cards catch momentum (flat OI) and strong build-ups the model gate skips', () => {
    const rows = (strike: number, mult: number) => [
      [strike, 0, 6, 5, Math.round(100_000 * mult), 100_000, 10_000],
      [strike, 1, 6, 5, Math.round(100_000 * mult), 100_000, 10_000],
    ];
    const market = {
      date: '2026-11-16',
      series: [
        { s: 'UJJIVANSFB', sp: 103.9, pc: 102, atm: 104, e: '2026-11-19', r: [...rows(104, 1), ...rows(105, 1)] },
        { s: 'SAGILITY', sp: 26.3, pc: 25.5, atm: 26, e: '2026-11-19', r: [...rows(26, 1.2), ...rows(27, 1.2)] },
      ],
    };
    const cards = earlyCards(market, '2026-11-16', NOW);
    expect(cards.map(card => card.symbol).sort()).toEqual(['SAGILITY', 'UJJIVANSFB']);
    expect(cards.find(card => card.symbol === 'SAGILITY')?.early).toBe('build-fast');
    expect(cards.find(card => card.symbol === 'UJJIVANSFB')?.early).toBe('momentum');
    expect(cards.every(card => card.side === 'CE' && card.entry > 0.5)).toBe(true);
    expect(earlyCards(market, '2026-11-16', NOW, cards)).toHaveLength(0);
  });

  it('early cards ride short covering and long unwinding, not just flat OI', () => {
    // Chain OI −10% (90k vs 100k per row); liquid ATM, no bid/ask spread gate.
    const rows = (strike: number) => [
      [strike, 0, 6, 5, 90_000, 100_000, 10_000],
      [strike, 1, 6, 5, 90_000, 100_000, 10_000],
    ];
    const covering = { s: 'COVER', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...rows(104), ...rows(105)] };
    const unwind = { s: 'UNWIND', sp: 96, pc: 100, atm: 96, e: '2026-11-19', r: [...rows(96), ...rows(95)] };
    const mildRows = (strike: number) => [[strike, 0, 6, 5, 103_000, 100_000, 10_000], [strike, 1, 6, 5, 103_000, 100_000, 10_000]];
    const mild = { s: 'MILD', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...mildRows(104), ...mildRows(105)] };
    const market = { date: '2026-11-16', series: [covering, unwind, mild] };
    const cards = earlyCards(market, '2026-11-16', NOW, [], { max: 3 });
    const cover = cards.find(card => card.symbol === 'COVER');
    const unw = cards.find(card => card.symbol === 'UNWIND');
    expect(cover?.early).toBe('momentum');
    expect(cover?.bias).toBe('bullish');
    expect(cover?.side).toBe('CE');
    expect(unw?.early).toBe('momentum');
    expect(unw?.bias).toBe('bearish');
    expect(unw?.side).toBe('PE');
    // A mild fresh build-up (+3% OI) still waits for confirmation.
    expect(cards.some(card => card.symbol === 'MILD')).toBe(false);
  });

  it('a rejected early candidate does not consume the cap slot', () => {
    const rows = (strike: number) => [[strike, 0, 6, 5, 100_000, 100_000, 10_000], [strike, 1, 6, 5, 100_000, 100_000, 10_000]];
    const bad = { s: 'BAD', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...rows(104), ...rows(105)] };
    const good = { s: 'GOOD', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...rows(104), ...rows(105)] };
    const market = { date: '2026-11-16', series: [bad, good] };
    const priceCard = (card: { symbol: string }) => card.symbol === 'BAD'
      ? { levelsBasis: 'no-edge', levelsRejected: 'test reject' }
      : { levelsBasis: 'backtest+decay', backtest: { expectancyPremium: 1, samples: 10 } };
    // One slot: the old cap handed it to BAD (then skipped) and starved GOOD.
    const cards = earlyCards(market, '2026-11-16', NOW, [], { max: 1, priceCard });
    expect(cards.map(card => card.symbol)).toEqual(['GOOD']);
  });

  it('counts only same-session open sector cards, enforces the limit, and exempts unknown/different sectors', () => {
    vi.stubEnv('SECTOR_CARD_CAP', '2');
    const sectorFor = (symbol: string) => symbol.startsWith('TECH') ? 'technology' : symbol === 'OTHER' ? 'energy' : null;
    const date = '2026-11-16';
    const budget = createSectorCardBudget([
      { symbol: 'TECH_SEED', date },
      { symbol: 'TECH_CLOSED', date, outcome: { status: 'sl' } },
      { symbol: 'TECH_OLD', date: '2026-11-13' },
    ], date, sectorFor);
    expect(budget.count('technology')).toBe(1);
    expect(budget.add({ symbol: 'TECH_SEED', date })).toMatchObject({ ok: true, alreadyCounted: true });
    expect(budget.add({ symbol: 'TECH_NEXT', date })).toMatchObject({ ok: true, sector: 'technology', added: true });
    expect(budget.count('technology')).toBe(2);
    expect(budget.add({ symbol: 'TECH_FULL', date })).toMatchObject({ ok: false, sector: 'technology' });
    expect(budget.add({ symbol: 'OTHER', date })).toMatchObject({ ok: true, sector: 'energy' });
    expect(budget.add({ symbol: 'UNKNOWN', date })).toMatchObject({ ok: true, sector: null });

    vi.stubEnv('SECTOR_CARD_CAP', '3');
    const overridden = createSectorCardBudget([{ symbol: 'TECH_SEED', date }], date, sectorFor);
    expect(overridden.add({ symbol: 'TECH_NEXT_1', date }).ok).toBe(true);
    expect(overridden.add({ symbol: 'TECH_NEXT_2', date }).ok).toBe(true);
    expect(overridden.count('technology')).toBe(3);
    expect(overridden.add({ symbol: 'TECH_NEXT_3', date })).toMatchObject({ ok: false, sector: 'technology' });
  });

  it('sector-gates early cards before they consume early slots', () => {
    vi.stubEnv('SECTOR_CARD_CAP', '2');
    const rows = (strike: number) => [[strike, 0, 6, 5, 100_000, 100_000, 10_000], [strike, 1, 6, 5, 100_000, 100_000, 10_000]];
    const mk = (symbol: string) => ({ s: symbol, sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...rows(104), ...rows(105)] });
    const market = { date: '2026-11-16', series: [mk('TECH_A'), mk('TECH_B'), mk('OTHER')] };
    const existing = [{ symbol: 'TECH_SEED', date: '2026-11-16' }];
    const logs: string[] = [];
    const cards = earlyCards(market, '2026-11-16', NOW, existing, {
      max: 4,
      sectorFor: symbol => symbol.startsWith('TECH') ? 'technology' : symbol === 'OTHER' ? 'energy' : null,
      priceCard: () => ({ levelsBasis: 'backtest+decay', backtest: { expectancyPremium: 1, samples: 10 } }),
      log: message => logs.push(message),
    });
    expect(cards.map(card => card.symbol).sort()).toEqual(['OTHER', 'TECH_A']);
    expect(logs).toContain('advisor skipped TECH_B: sector cluster full: technology');
  });

  it('drops momentum cards that run against the live futures trend', () => {
    const rows = (strike: number) => [[strike, 0, 6, 5, 100_000, 100_000, 10_000], [strike, 1, 6, 5, 100_000, 100_000, 10_000]];
    const mk = (symbol: string, sp: number, pc: number) => ({ s: symbol, sp, pc, atm: sp, e: '2026-11-19', r: [...rows(sp), ...rows(sp + 1)] });
    const market = { date: '2026-11-16', series: [mk('AGAINST', 100, 98), mk('ALIGNED', 104, 100), mk('FLATSYM', 104, 100), mk('NIFTY', 25000, 25000)] };
    const trendFor = (symbol: string) => symbol === 'AGAINST' ? -0.5 : symbol === 'NIFTY' ? 0.4 : symbol === 'FLATSYM' ? 0.05 : 0.4;
    const cards = earlyCards(market, '2026-11-16', NOW, [], { max: 5, trendFor });
    expect(cards.map(card => card.symbol).sort()).toEqual(['ALIGNED', 'FLATSYM']);
  });

  it('drops momentum cards when the index trend runs against the bias', () => {
    const rows = (strike: number) => [[strike, 0, 6, 5, 100_000, 100_000, 10_000], [strike, 1, 6, 5, 100_000, 100_000, 10_000]];
    const mk = (symbol: string, sp: number, pc: number) => ({ s: symbol, sp, pc, atm: sp, e: '2026-11-19', r: [...rows(sp), ...rows(sp + 1)] });
    const market = { date: '2026-11-16', series: [mk('BULLA', 104, 100), mk('NIFTY', 25000, 25000)] };
    const idxAgainst = (symbol: string) => symbol === 'NIFTY' ? -0.5 : 0.6;
    expect(earlyCards(market, '2026-11-16', NOW, [], { max: 5, trendFor: idxAgainst })).toHaveLength(0);
    // Index aligned again → the same card returns.
    const idxAligned = (symbol: string) => symbol === 'NIFTY' ? 0.3 : 0.6;
    expect(earlyCards(market, '2026-11-16', NOW, [], { max: 5, trendFor: idxAligned }).map(card => card.symbol)).toEqual(['BULLA']);
  });

  it('keeps build-fast cards even when the trend gate would object', () => {
    // OI +20% → build-fast path; trend against — the OI confirmation wins.
    const rows = (strike: number) => [[strike, 0, 6, 5, 120_000, 100_000, 10_000], [strike, 1, 6, 5, 120_000, 100_000, 10_000]];
    const mk = (symbol: string, sp: number, pc: number) => ({ s: symbol, sp, pc, atm: sp, e: '2026-11-19', r: [...rows(sp), ...rows(sp + 1)] });
    const market = { date: '2026-11-16', series: [mk('STRONG', 104, 100), mk('NIFTY', 25000, 25000)] };
    const cards = earlyCards(market, '2026-11-16', NOW, [], { max: 5, trendFor: () => -0.5 });
    expect(cards.map(card => card.symbol)).toEqual(['STRONG']);
    expect(cards[0].early).toBe('build-fast');
  });

  it('momentum PCR gate rejects opposing PCR shifts, passes unknown/aligned shifts, and exempts build-fast', () => {
    vi.stubEnv('MOMENTUM_PCR_GATE_PCT', '3');
    const rows = (strike: number, oi = 100_000, prevOi = 100_000) => [
      [strike, 0, 6, 5, oi, prevOi, 10_000],
      [strike, 1, 6, 5, oi, prevOi, 10_000],
    ];
    const mk = (symbol: string, spot: number, pc: number, oi = 100_000, prevOi = 100_000) => ({
      s: symbol, sp: spot, pc, atm: spot, e: '2026-11-19', r: [...rows(spot, oi, prevOi), ...rows(spot + (spot > pc ? 1 : -1), oi, prevOi)],
    });
    const market = { date: '2026-11-16', series: [
      mk('BULL_RISING', 104, 100),
      mk('BEAR_FALLING', 96, 100),
      mk('PCR_UNKNOWN', 104, 100),
      mk('PCR_ALIGNED', 104, 100),
      mk('PCR_BUILD_FAST', 104, 100, 120_000, 100_000),
    ] };
    const shifts: Record<string, number | null> = {
      BULL_RISING: 3,
      BEAR_FALLING: -3,
      PCR_UNKNOWN: null,
      PCR_ALIGNED: 2.99,
      PCR_BUILD_FAST: 8,
    };
    const logs: string[] = [];
    const cards = earlyCards(market, '2026-11-16', NOW, [], {
      max: 5,
      pcrShiftFor: symbol => shifts[symbol] ?? null,
      priceCard: () => ({ levelsBasis: 'backtest+decay', backtest: { expectancyPremium: 1, samples: 10 } }),
      log: message => logs.push(message),
    });

    expect(cards.map(card => card.symbol).sort()).toEqual(['PCR_ALIGNED', 'PCR_BUILD_FAST', 'PCR_UNKNOWN']);
    expect(cards.find(card => card.symbol === 'PCR_BUILD_FAST')?.early).toBe('build-fast');
    expect(logs).toContain('advisor momentum pcr-gate: BULL_RISING bullish pcrDelta +3.0% — skipped');
    expect(logs).toContain('advisor momentum pcr-gate: BEAR_FALLING bearish pcrDelta -3.0% — skipped');
    expect(logs).toHaveLength(2);

    const oneSlot = earlyCards(market, '2026-11-16', NOW, [], {
      max: 1,
      pcrShiftFor: symbol => shifts[symbol] ?? null,
      priceCard: () => ({ levelsBasis: 'backtest+decay', backtest: { expectancyPremium: 1, samples: 10 } }),
    });
    expect(oneSlot.map(card => card.symbol)).toEqual(['PCR_UNKNOWN']);
  });

  it('range-gates momentum and build-fast, keeps trend/unknown regimes, and can be disabled', () => {
    vi.stubEnv('ADVISOR_RANGE_GATE', '1');
    const rows = (strike: number, oi = 100_000, prevOi = 100_000) => [
      [strike, 0, 6, 5, oi, prevOi, 10_000],
      [strike, 1, 6, 5, oi, prevOi, 10_000],
    ];
    const mk = (symbol: string, spot: number, pc: number, oi = 100_000, prevOi = 100_000) => ({
      s: symbol, sp: spot, pc, atm: spot, e: '2026-11-19', r: [...rows(spot, oi, prevOi), ...rows(spot + (spot > pc ? 1 : -1), oi, prevOi)],
    });
    const market = { date: '2026-11-16', series: [
      mk('RANGE_MOM', 104, 100),
      mk('RANGE_BUILD_FAST', 104, 100, 120_000, 100_000),
      mk('TREND_UP', 104, 100),
      mk('REGIME_UNKNOWN', 104, 100),
    ] };
    const regimes: Record<string, string | null> = {
      RANGE_MOM: 'range',
      RANGE_BUILD_FAST: 'range',
      TREND_UP: 'up',
      REGIME_UNKNOWN: null,
    };
    const logs: string[] = [];
    const options = {
      max: 5,
      regimeFor: (symbol: string) => regimes[symbol],
      priceCard: () => ({ levelsBasis: 'backtest+decay', backtest: { expectancyPremium: 1, samples: 10 } }),
      log: (message: string) => logs.push(message),
    };
    const cards = earlyCards(market, '2026-11-16', NOW, [], options);
    expect(cards.map(card => card.symbol).sort()).toEqual(['REGIME_UNKNOWN', 'TREND_UP']);
    expect(logs).toContain('advisor regime gate: RANGE_MOM bullish regime=range — skipped');
    expect(logs).toContain('advisor regime gate: RANGE_BUILD_FAST bullish regime=range — skipped');

    vi.stubEnv('ADVISOR_RANGE_GATE', '0');
    const disabled = earlyCards(market, '2026-11-16', NOW, [], options);
    expect(disabled.map(card => card.symbol).sort()).toEqual(['RANGE_BUILD_FAST', 'RANGE_MOM', 'REGIME_UNKNOWN', 'TREND_UP']);
  });

  it('momentum premium must confirm the move — flat and late-chase premiums are skipped', () => {
    const row = (strike: number, ltp: number, prev: number) => [[strike, 0, ltp, prev, 100_000, 100_000, 10_000], [strike, 1, ltp, prev, 100_000, 100_000, 10_000]];
    const mk = (symbol: string, ltp: number, prev: number) => ({ s: symbol, sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [...row(104, ltp, prev), ...row(105, ltp, prev)] });
    const market = { date: '2026-11-16', series: [mk('FLATPREM', 5.1, 5), mk('GOODPREM', 6, 5), mk('LATEPREM', 7, 5), { s: 'NIFTY', sp: 25000, pc: 25000, atm: 25000, e: '2026-11-19', r: [...row(25000, 6, 5), ...row(25001, 6, 5)] }] };
    // FLATPREM +2% (divergence); GOODPREM +20% (confirms); LATEPREM +40% (late chase).
    const cards = earlyCards(market, '2026-11-16', NOW, [], { max: 5 });
    expect(cards.map(card => card.symbol)).toEqual(['GOODPREM']);
  });

  it('momentum waits out the opening chop; build-fast does not', () => {
    const mom = (symbol: string) => ({ s: symbol, sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: [[104, 0, 6, 5, 100_000, 100_000, 10_000], [104, 1, 6, 5, 100_000, 100_000, 10_000], [105, 0, 6, 5, 100_000, 100_000, 10_000], [105, 1, 6, 5, 100_000, 100_000, 10_000]] });
    const strongRows = [[104, 0, 6, 5, 120_000, 100_000, 10_000], [104, 1, 6, 5, 120_000, 100_000, 10_000], [105, 0, 6, 5, 120_000, 100_000, 10_000], [105, 1, 6, 5, 120_000, 100_000, 10_000]];
    const market = { date: '2026-11-16', series: [{ s: 'MOM', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: mom('MOM').r }, { s: 'STRONG', sp: 104, pc: 100, atm: 104, e: '2026-11-19', r: strongRows }, { s: 'NIFTY', sp: 25000, pc: 25000, atm: 25000, e: '2026-11-19', r: mom('NIFTY').r }] };
    const now0920 = Date.parse('2026-11-16T03:50:00Z'); // 09:20 IST — inside the chop
    expect(earlyCards(market, '2026-11-16', now0920, [], { max: 5 }).map(card => card.symbol)).toEqual(['STRONG']);
    const now0935 = Date.parse('2026-11-16T04:05:00Z'); // 09:35 IST — chop over
    expect(earlyCards(market, '2026-11-16', now0935, [], { max: 5 }).map(card => card.symbol).sort()).toEqual(['MOM', 'STRONG']);
  });

  it('tags a card with the owner ORB playbook at build time', () => {
    const open = Date.parse('2026-11-16T09:15:00+05:30');
    const candles = [0, 1, 2, 3, 4].map(minute => ({
      at: open + minute * 60_000, close: 293 + minute, high: 295, low: 292.5, open: 293,
    }));
    const snapshot = { symbol: 'MANAPPURAM', session: '2026-11-16', months: [{ candles }] };
    const card = { spot: 296, bias: 'bullish', oiChangePct: 11.7 };
    expect(orbStrategy(snapshot, card, NOW)).toMatchObject({ qualifies: true });
    expect(orbStrategy(snapshot, card, NOW).label).toContain('ORB ✓');
    expect(orbStrategy(snapshot, { ...card, spot: 294 }, NOW).label).toContain('no breakout yet');
    expect(orbStrategy(snapshot, { ...card, spot: 307 }, NOW).label).toContain('VWAP');
    expect(orbStrategy(snapshot, { ...card, oiChangePct: 3 }, NOW).label).toContain('<5% needed');
    expect(orbStrategy(snapshot, { ...card, oiChangePct: null }, NOW).label).toContain('unknown');
    const thin = { ...snapshot, months: [{ candles: candles.slice(0, 2) }] };
    // A quiet minute prints no candle: two prints still form the opening range.
    expect(orbStrategy(thin, card, NOW).label).toContain('ORB ✓');
    expect(orbStrategy({ ...snapshot, months: [{ candles: [] }] }, card, NOW).label).toContain('range pending');
    expect(orbStrategy(null, card, NOW)).toBeNull();
  });

  it('switches to the next-expiry block when the near expiry is inside the DTE threshold', () => {
    const next = { e: '2026-12-31', sp: 300.9, pc: 308.2, atm: 300, r: [[300, 0, 12, 11, 2_000_000, 1_800_000, 50_000]] };
    // Exactly 3 DTE (expiry 15:30 IST − same clock time) → the December block wins.
    const boundary = Date.parse('2026-11-16T15:30:00+05:30');
    const near3 = { ...seriesFixture(), e: '2026-11-19', next };
    const chosen = chooseChain(near3, boundary);
    expect(chosen.e).toBe('2026-12-31');
    expect(chosen.sp).toBe(300.9);
    expect(chosen.r).toEqual(next.r);
    // Past the threshold → today's behaviour (near chain stays).
    const near8 = { ...seriesFixture(), e: '2026-11-24', next };
    expect(chooseChain(near8, NOW).e).toBe('2026-11-24');
    // No next block, or a broken expiry → unchanged.
    expect(chooseChain(seriesFixture(), NOW).e).toBe('2026-11-19');
    expect(chooseChain({ ...seriesFixture(), e: 'not-a-date', next }, NOW).e).toBe('not-a-date');
  });

  it('falls back to the next expiry when the near chain has no liquid candidate', () => {
    // Wide spreads (>2%) on every near strike — OI/volume alone do not qualify.
    const wide = (strike: number, side: number, ltp: number) => [strike, side, ltp, ltp, 500_000, 500_000, 50_000, 0, ltp, 20, ltp - 1, ltp + 1];
    const dustNear = { ...seriesFixture(), e: '2026-11-24', r: [wide(300, 0, 6), wide(300, 1, 6), wide(305, 0, 4), wide(295, 1, 4)] };
    const liquidNext = { e: '2026-12-31', sp: 300.9, pc: 308.2, atm: 300, r: [[300, 0, 12, 11, 2_000_000, 1_800_000, 50_000]] };
    expect(candidateStrikes(dustNear, 'bullish')).toHaveLength(0);
    expect(candidateStrikes(dustNear, 'bearish')).toHaveLength(0);
    // 8 DTE — past the theta threshold — yet the liquid monthly wins.
    const chosen = chooseChain({ ...dustNear, next: liquidNext }, NOW);
    expect(chosen.e).toBe('2026-12-31');
    expect(candidateStrikes(chosen, 'bullish').length).toBeGreaterThan(0);
    // Both chains dust → no pointless switch; the near block stays.
    const dustNext = { ...liquidNext, r: [wide(300, 0, 12)] };
    expect(chooseChain({ ...dustNear, next: dustNext }, NOW).e).toBe('2026-11-24');
    // A liquid near chain keeps its expiry even when a next block exists.
    expect(chooseChain({ ...seriesFixture(), e: '2026-11-24', next: liquidNext }, NOW).e).toBe('2026-11-24');
  });

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

  it('writes a card at quality ≥0.65 with a decisive pick', () => {
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

  it('normalizes a 0-100 quality answer onto the 0-1 gate (P0-S3)', () => {
    const answers = (quality: number) => ({ quality_MANAPPURAM: { noul: quality }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const percent = advisorDecisions([watch], answers(80));
    expect(percent.cards).toHaveLength(1);
    expect(percent.cards[0].quality).toBeCloseTo(0.8, 5);
    expect(advisorDecisions([watch], answers(0.8)).cards).toHaveLength(1);
    const low = advisorDecisions([watch], answers(45));
    expect(low.cards).toHaveLength(0);
    expect(low.skipped[0].reason).toBe('quality 45%');
    expect(advisorDecisions([watch], { quality_MANAPPURAM: { noul: 'n/a' }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } }).skipped[0].reason).toBe('quality unknown');
  });

  it('uses a stable symbol/session identity across advisor passes', () => {
    const answers = { quality_MANAPPURAM: { noul: 0.8 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.75 } } };
    const first = advisorDecisions([{ ...watch, at: NOW }], answers).cards[0];
    const later = advisorDecisions([{ ...watch, at: NOW + 10 * 60_000 }], answers).cards[0];

    expect(first.id).toBe('MANAPPURAM|2026-11-16');
    expect(later.id).toBe(first.id);
  });
});

describe('observation deduplication', () => {
  it('keeps the first card per symbol/session while allowing another day', () => {
    const latest = { id: 'NIFTY|2026-11-16', symbol: 'NIFTY', date: '2026-11-16', entry: 10 };
    const duplicate = { id: 'NIFTY-1731730000', symbol: 'NIFTY', date: '2026-11-16', entry: 9 };
    const nextDay = { id: 'NIFTY|2026-11-17', symbol: 'NIFTY', date: '2026-11-17', entry: 11 };
    expect(dedupeObservations([latest, duplicate, nextDay])).toEqual([latest, nextDay]);
  });

  it('normalizes duplicate persisted cards on read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-dedupe-'));
    const obsPath = join(dir, 'observations.json');
    try {
      writeFileSync(obsPath, JSON.stringify({ cards: [
        { id: 'new', symbol: 'NIFTY', date: '2026-11-16' },
        { id: 'old', symbol: 'NIFTY', date: '2026-11-16' },
        { id: 'other', symbol: 'SENSEX', date: '2026-11-16' },
      ] }));
      expect(loadObservations(obsPath).map(card => card.id)).toEqual(['new', 'other']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('sends one upgrade note when a model card replaces an early signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-upgrade-'));
    const obsPath = join(dir, 'observations.json');
    writeFileSync(obsPath, JSON.stringify({ cards: [{ id: 'UPGTEST|2026-11-16', symbol: 'UPGTEST', date: '2026-11-16', early: 'momentum', entry: 4, expiry: '2026-11-19' }] }));
    const marketSeries = { ...seriesFixture(), s: 'UPGTEST' };
    const ask = async () => ({ quality_UPGTEST: { noul: 80 }, strike_UPGTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const upgrades: string[] = [];
    const sent: unknown[] = [];
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches: [{ symbol: 'UPGTEST', bias: 'bullish' }],
        now: NOW,
        ask,
        send: async message => { sent.push(message); return { sent: true }; },
        sendUpgrade: async text => { upgrades.push(text); return { sent: true }; },
      });
      expect(result.written).toBe(1);
      // The upgrade replaces the early card in place, so it is not "fresh" — only the note goes out.
      expect(sent).toHaveLength(0);
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0]).toContain('Upgrade · UPGTEST');
      expect(upgrades[0]).toContain('quality 80%');
      expect(loadObservations(obsPath)[0]).toMatchObject({ symbol: 'UPGTEST', quality: 0.8 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates one symbol/session card but sends only one Telegram note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-once-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'DUPTEST' };
    const watches = [{ symbol: 'DUPTEST', bias: 'bullish' }];
    const ask = async () => ({ quality_DUPTEST: { noul: 0.9 }, strike_DUPTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const sent = [];
    try {
      const first = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW, ask, send: async message => { sent.push(message); return { sent: true }; },
      });
      const second = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW + 10 * 60_000, ask, send: async message => { sent.push(message); return { sent: true }; },
      });

      const cards = loadObservations(obsPath);
      expect(first.written).toBe(1);
      expect(second.written).toBe(1);
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe('DUPTEST|2026-11-16');
      expect(cards[0].at).toBe(NOW + 10 * 60_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ symbol: 'DUPTEST', date: '2026-11-16', spot: 300.4, spotChangePct: expect.any(Number) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends the stripped subscriber copy instantly when subscriber ids are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-sub-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'SUBTEST' };
    const watches = [{ symbol: 'SUBTEST', bias: 'bullish' }];
    const ask = async () => ({ quality_SUBTEST: { noul: 0.9 }, strike_SUBTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const subs: Array<{ text: string; chatId: number }> = [];
    try {
      await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW, ask,
        send: async () => ({ sent: true }),
        subscriberChatIds: [123, 456],
        sendSubscriber: async (text, chatId) => { subs.push({ text, chatId }); return { sent: true }; },
      });
      expect(subs).toHaveLength(2);
      expect(subs[0].chatId).toBe(123);
      expect(subs[0].text).toContain('SUBTEST');
      expect(subs[0].text).not.toMatch(/jev|quality|advisor/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the near-chain PCR and shift identically on advisor cards and subscriber copies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-pcr-context-'));
    const obsPath = join(dir, 'observations.json');
    const near = { ...seriesFixture(), s: 'PCRCARD' };
    const next = { e: '2026-12-31', r: [[300, 0, 10, 9, 10_000_000, 9_000_000, 50_000], [300, 1, 10, 9, 1_000_000, 900_000, 50_000]] };
    const marketSeries = { ...near, next };
    const ask = async () => ({ quality_PCRCARD: { noul: 0.9 }, strike_PCRCARD: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const sent: unknown[] = [];
    const subscribers: string[] = [];
    const pcrShiftFor = vi.fn(() => -4.2);
    try {
      await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches: [{ symbol: 'PCRCARD', bias: 'bullish' }],
        now: NOW,
        ask,
        pcrShiftFor,
        send: async card => { sent.push(card); return { sent: true }; },
        subscriberChatIds: [123],
        sendSubscriber: async text => { subscribers.push(text); return { sent: true }; },
      });
      const stored = loadObservations(obsPath)[0];
      expect(stored.pcrAtEntry).toBeCloseTo(7_400_000 / 8_200_000, 6);
      expect(stored.pcrShift).toBe(-4.2);
      expect(sent[0]).toMatchObject({ pcrAtEntry: stored.pcrAtEntry, pcrShift: stored.pcrShift });
      expect(subscribers[0]).toContain('PCR 0.90 (−4% 15m)');
      expect(pcrShiftFor).toHaveBeenCalledWith('PCRCARD', NOW);
      expect(stored.pcrAtEntry).not.toBeCloseTo(0.1, 1); // next-expiry PCR is deliberately ignored.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds near-chain PCR context to re-entry cards as well', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-reentry-pcr-'));
    const obsPath = join(dir, 'observations.json');
    const prev = {
      id: 'RETEST|2026-11-16', symbol: 'RETEST', date: '2026-11-16', at: NOW - 60_000,
      expiry: '2026-11-19', strike: 300, side: 'CE', bias: 'bullish', entry: 4, sl: 2, tgt1: 6.2, tgt2: 7.6,
      outcome: { status: 'sl', r: -1 },
    };
    writeFileSync(obsPath, JSON.stringify({ cards: [prev] }));
    const marketSeries = { ...seriesFixture(), s: 'RETEST', pc: 300.4 };
    const sent: Array<Record<string, unknown>> = [];
    try {
      await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches: [{ symbol: 'RETEST', bias: 'bullish' }],
        now: NOW,
        ask: async () => ({ quality_RETEST: { noul: 0.4 }, strike_RETEST: { choice: 'c1', probabilities: { c1: 0.9 } } }),
        pcrShiftFor: () => -4.2,
        send: async card => { sent.push(card); return { sent: true }; },
      });
      const stored = loadObservations(obsPath).find(card => card.reEntry === 1);
      expect(stored).toMatchObject({ pcrAtEntry: 7_400_000 / 8_200_000, pcrShift: -4.2 });
      expect(sent.find(card => card.reEntry === 1)).toMatchObject({ pcrAtEntry: stored?.pcrAtEntry, pcrShift: stored?.pcrShift });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets pcrAtEntry and pcrShift on fresh and re-entry cards in one advisor run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-pcr-both-'));
    const obsPath = join(dir, 'observations.json');
    const reEntrySeed = {
      id: 'PCR_RE|2026-11-16', symbol: 'PCR_RE', date: '2026-11-16', at: NOW - 60_000,
      expiry: '2026-11-19', strike: 300, side: 'CE', bias: 'bullish', entry: 4, sl: 2, tgt1: 6.2, tgt2: 7.6,
      tsl: 'after TGT1, trail to entry', support: null, resistance: null, quality: 0.8, strikePickProbability: 0.9,
      oiChangePct: 1, outcome: { status: 'sl', r: -1 }, disclaimer: 'test',
    };
    writeFileSync(obsPath, JSON.stringify({ cards: [reEntrySeed] }));
    const freshSeries = { ...seriesFixture(), s: 'PCR_FRESH' };
    const reEntrySeries = { ...seriesFixture(), s: 'PCR_RE', pc: 300.4 };
    const symbols = ['PCR_FRESH', 'PCR_RE'];
    const sent: Array<Record<string, unknown>> = [];
    const shifts: Record<string, number> = { PCR_FRESH: -4.2, PCR_RE: 5.6 };
    try {
      await runAdvisor({ date: '2026-11-16', series: [freshSeries, reEntrySeries] }, {
        obsPath,
        watches: symbols.map(symbol => ({ symbol, bias: 'bullish' })),
        now: NOW,
        ask: async () => ({
          quality_PCR_FRESH: { noul: 0.9 },
          strike_PCR_FRESH: { choice: 'c1', probabilities: { c1: 0.9 } },
          quality_PCR_RE: { noul: 0.4 },
          strike_PCR_RE: { choice: 'c1', probabilities: { c1: 0.9 } },
        }),
        pcrShiftFor: symbol => shifts[symbol] ?? null,
        send: async card => { sent.push(card); return { sent: true }; },
      });
      const stored = loadObservations(obsPath);
      const fresh = stored.find(card => card.symbol === 'PCR_FRESH');
      const reEntry = stored.find(card => card.symbol === 'PCR_RE' && card.reEntry === 1);
      expect(fresh).toMatchObject({ pcrAtEntry: 7_400_000 / 8_200_000, pcrShift: -4.2 });
      expect(reEntry).toMatchObject({ pcrAtEntry: 7_400_000 / 8_200_000, pcrShift: 5.6 });
      expect(sent.find(card => card.symbol === 'PCR_FRESH')).toMatchObject({ pcrAtEntry: fresh?.pcrAtEntry, pcrShift: -4.2 });
      expect(sent.find(card => card.symbol === 'PCR_RE' && card.reEntry === 1)).toMatchObject({ pcrAtEntry: reEntry?.pcrAtEntry, pcrShift: 5.6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the sector cap in the advisor accept loop and counts only kept current-batch cards', async () => {
    vi.stubEnv('SECTOR_CARD_CAP', '2');
    const dir = mkdtempSync(join(tmpdir(), 'obs-sector-accept-'));
    const obsPath = join(dir, 'observations.json');
    writeFileSync(obsPath, JSON.stringify({ cards: [{ id: 'TECH_SEED|2026-11-16', symbol: 'TECH_SEED', date: '2026-11-16' }] }));
    const symbols = ['MODEL_A', 'MODEL_B', 'OTHER'];
    const series = symbols.map(symbol => ({ ...seriesFixture(), s: symbol }));
    const watches = symbols.map(symbol => ({ symbol, bias: 'bullish' }));
    const ask = async () => Object.fromEntries(symbols.flatMap(symbol => [
      [`quality_${symbol}`, { noul: 0.9 }],
      [`strike_${symbol}`, { choice: 'c1', probabilities: { c1: 0.9 } }],
    ]));
    const logs: string[] = [];
    try {
      const result = await runAdvisor({ date: '2026-11-16', series }, {
        obsPath,
        watches,
        now: NOW,
        ask,
        sectorFor: symbol => symbol === 'OTHER' ? 'energy' : 'technology',
        send: async () => ({ sent: true }),
        log: message => logs.push(message),
      });
      expect(result.written).toBe(2);
      expect(loadObservations(obsPath).map(card => card.symbol).sort()).toEqual(['MODEL_A', 'OTHER', 'TECH_SEED']);
      expect(logs).toContain('advisor skipped MODEL_B: sector cluster full: technology');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('samples cached live readings immediately before sending without persisting them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-live-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'LIVEV2' };
    const watches = [{ symbol: 'LIVEV2', bias: 'bullish' }];
    const events: string[] = [];
    let sentCard: Record<string, unknown> | null = null;

    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches,
        now: NOW,
        configured: () => true,
        ask: async () => ({ quality_LIVEV2: { noul: 0.9 }, strike_LIVEV2: { choice: 'c1', probabilities: { c1: 0.9 } } }),
        getLive: card => {
          events.push('live');
          expect(card.symbol).toBe('LIVEV2');
          return { spot: 300.5, future: 301, option: 4.2 };
        },
        send: async card => {
          events.push('send');
          sentCard = card;
          return { sent: true };
        },
      });

      expect(result.written).toBe(1);
      expect(events).toEqual(['live', 'send']);
      expect(sentCard).toMatchObject({ sentAt: NOW, live: { spot: 300.5, future: 301, option: 4.2 } });
      expect(loadObservations(obsPath)[0]).not.toHaveProperty('live');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes gamma fields as Jev state and adds deterministic pin/stop notes to the card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-gamma-'));
    const obsPath = join(dir, 'observations.json');
    const row = (strike: number, side: number, ltp: number, oi: number, prevOi: number) => [
      strike, side, ltp, Math.max(0.1, ltp - 1), oi, prevOi, 5_000, 80, ltp, 20,
    ];
    const series = {
      s: 'NIFTY', sp: 100.4, pc: 99.4, atm: 100, t: NOW, e: '2026-11-17', lot: 50,
      r: [
        row(90, 0, 15, 1_000_000, 900_000), row(90, 1, 1, 1_000_000, 900_000),
        row(95, 0, 10, 1_000_000, 900_000), row(95, 1, 2, 2_000_000, 1_000_000),
        row(100, 0, 5, 1_000_000, 900_000), row(100, 1, 5, 500_000, 400_000),
        row(105, 0, 2, 10_000_000, 8_000_000), row(105, 1, 8, 1_000_000, 900_000),
        row(110, 0, 1, 1_000_000, 900_000), row(110, 1, 12, 1_000_000, 900_000),
      ],
    };
    const expectedProfile = gammaProfile(series, { lot: 50, r: 0.065 });
    const watches = [{ symbol: 'NIFTY', bias: 'bullish' }];
    let jevState: any;
    let sentCard: any;

    try {
      vi.stubEnv('GAMMA_SYMBOLS', 'NIFTY');
      vi.stubEnv('GAMMA_RISK_FREE', '0.065');
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches,
        now: NOW,
        configured: () => true,
        ask: async (state: unknown) => {
          jevState = state;
          return { quality_NIFTY: { noul: 0.9 }, strike_NIFTY: { choice: 'c1', probabilities: { c1: 0.9 } } };
        },
        send: async (value: unknown) => { sentCard = value; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      const firstCandidate = jevState.chain.NIFTY.candidates[0];
      expect(firstCandidate).toMatchObject({ strike: 100, regime: expectedProfile.regime });
      expect(firstCandidate.gexAtStrike).toBeGreaterThan(0);
      expect(firstCandidate.distanceToFlip).toBeTypeOf('number');
      expect(expectedProfile.flipLevel).toBeGreaterThan(95);
      expect(sentCard.gamma).toMatchObject({ regime: expectedProfile.regime, flipLevel: expectedProfile.flipLevel, pin: '100CE' });
      expect(sentCard.gamma.notes).toEqual(expect.arrayContaining([
        expect.stringContaining('Gamma pin zone'),
        expect.stringContaining('Wall-based stop sits beyond the gamma flip'),
      ]));
      expect(loadObservations(obsPath)[0].gamma).toMatchObject({ gexAtStrike: firstCandidate.gexAtStrike, distanceToFlip: firstCandidate.distanceToFlip });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds a futures ATR range line to a card without putting ATR in Jev state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-atr-'));
    const obsPath = join(dir, 'observations.json');
    const now = Date.parse('2026-11-16T09:00:00Z'); // 14:30 IST: after the synthetic bars
    const series = { ...seriesFixture(), s: 'ATRTEST' };
    const candles = Array.from({ length: 20 }, (_, index) => {
      const close = 100 + index;
      return { at: now - (20 - index) * 15 * 60_000, open: close - 0.5, high: close + 2, low: close - 1, close, oi: 1_000 + index };
    });
    let jevState: any;
    let sentCard: any;
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches: [{ symbol: 'ATRTEST', bias: 'bullish' }],
        now,
        configured: () => true,
        ask: async (state: unknown) => {
          jevState = state;
          return { quality_ATRTEST: { noul: 0.9 }, strike_ATRTEST: { choice: 'c1', probabilities: { c1: 0.9 } } };
        },
        readFuturesSnapshot: async (symbol, session) => ({ symbol, session, months: [{ date: '2026-11-26', candles }] }),
        send: async card => { sentCard = card; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      expect(jevState.chain.ATRTEST).not.toHaveProperty('atr');
      expect(sentCard.atr).toMatchObject({ barMinutes: 15, state: expect.stringMatching(/^(compressed|normal|expanded)$/) });
      expect(sentCard.atr.value).toBeGreaterThanOrEqual(0);
      expect(observationCaption(sentCard)).toContain(`Range: Futures ATR(15m) ${sentCard.atr.value.toFixed(2)} pts · ${sentCard.atr.state}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the range line, without blocking the card, when only five bars exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-atr-short-'));
    const obsPath = join(dir, 'observations.json');
    const now = Date.parse('2026-11-16T09:00:00Z');
    const series = { ...seriesFixture(), s: 'SHORTATR' };
    const candles = Array.from({ length: 5 }, (_, index) => {
      const close = 100 + index;
      return { at: now - (5 - index) * 15 * 60_000, open: close - 0.5, high: close + 2, low: close - 1, close };
    });
    let sentCard: any;
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches: [{ symbol: 'SHORTATR', bias: 'bullish' }],
        now,
        configured: () => true,
        ask: async () => ({ quality_SHORTATR: { noul: 0.9 }, strike_SHORTATR: { choice: 'c1', probabilities: { c1: 0.9 } } }),
        readFuturesSnapshot: (symbol, session) => ({ symbol, session, months: [{ date: '2026-11-26', candles }] }),
        send: async card => { sentCard = card; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      expect(sentCard.atr).toBeNull();
      expect(observationCaption(sentCard)).not.toContain('Futures ATR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an eligible card when futures data is missing, corrupt, cross-symbol, or future-dated', async () => {
    const cases = [
      ['missing', () => null],
      ['corrupt', () => { throw new Error('unavailable'); }],
      ['cross-symbol', () => ({ symbol: 'OTHER', session: '2026-11-16', months: [] })],
      ['future-candle', () => ({ symbol: 'SAFEATR', session: '2026-11-16', months: [{ date: '2026-11-26', candles: [{ at: NOW + 60_000, close: 101 }] }] })],
    ] as const;
    for (const [label, readFuturesSnapshot] of cases) {
      const dir = mkdtempSync(join(tmpdir(), `obs-atr-${label}-`));
      const obsPath = join(dir, 'observations.json');
      const series = { ...seriesFixture(), s: 'SAFEATR' };
      try {
        const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
          obsPath,
          watches: [{ symbol: 'SAFEATR', bias: 'bullish' }],
          now: NOW,
          configured: () => true,
          ask: async () => ({ quality_SAFEATR: { noul: 0.9 }, strike_SAFEATR: { choice: 'c1', probabilities: { c1: 0.9 } } }),
          readFuturesSnapshot,
          send: async () => ({ sent: true }),
        });
        expect(result.written, label).toBe(1);
        expect(loadObservations(obsPath)[0].atr, label).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
