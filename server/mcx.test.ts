import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { mcxCards, runMcxCards } from './strikeAdvisor.mjs';
import { resolveMcxCard } from './journal.mjs';

const NOW = Date.parse('2026-11-26T04:35:00.000Z'); // 10:05 IST
const DATE = '2026-11-26';

function mcxSeries(symbol, spot, prev, exchange = 'MCX') {
  return { s: symbol, sp: spot, pc: prev, e: '2026-12-29', exchange, r: [] };
}

const readFuturesSnapshot = (symbol, date) => ({
  symbol,
  session: date,
  months: [{ date, prevOi: 1000, candles: [{ at: NOW - 60_000, open: 1, high: 1, low: 1, close: 1, oi: 1060 }] }],
});

// Real measured stores back these tests: NATURALGAS is range-regime (passes
// both sides), GOLD is down-regime (blocks bullish builds).
describe('mcxCards', () => {
  it('creates a bullish futures-direct card when move + OI confirm (NATURALGAS, range regime)', () => {
    const market = { series: [mcxSeries('NATURALGAS', 30_200, 29_986)] }; // +0.71%
    const cards = mcxCards(market, DATE, NOW, [], { readFuturesSnapshot, log: () => {} });
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.exchange).toBe('MCX');
    expect(card.side).toBe('FUT');
    expect(card.bias).toBe('bullish');
    expect(card.entry).toBe(30_200);
    expect(card.tgt1).toBeGreaterThan(card.entry);
    expect(card.sl).toBeLessThan(card.entry);
    expect(card.early).toBe('mcx');
    expect(card.levelsBasis).toBe('mcx-fut-history');
  });

  it('blocks a bullish card in a down regime (GOLD)', () => {
    const market = { series: [mcxSeries('GOLD', 125_000, 124_100)] }; // +0.72%
    const cards = mcxCards(market, DATE, NOW, [], { readFuturesSnapshot, log: () => {} });
    expect(cards.length).toBe(0);
  });

  it('skips moves below the 0.7% gate', () => {
    const market = { series: [mcxSeries('NATURALGAS', 30_100, 29_986)] }; // +0.38%
    const cards = mcxCards(market, DATE, NOW, [], { readFuturesSnapshot, log: () => {} });
    expect(cards.length).toBe(0);
  });

  it('dedupes against an existing same-day card', () => {
    const market = { series: [mcxSeries('NATURALGAS', 30_200, 29_986)] };
    const existing = [{ symbol: 'NATURALGAS', date: DATE, id: 'NATURALGAS|2026-11-26' }];
    const cards = mcxCards(market, DATE, NOW, existing, { readFuturesSnapshot, log: () => {} });
    expect(cards.length).toBe(0);
  });

  it('ignores NSE/BSE series entirely', () => {
    const market = { series: [mcxSeries('TITAN', 4700, 4650, 'NSE')] };
    const cards = mcxCards(market, DATE, NOW, [], { readFuturesSnapshot, log: () => {} });
    expect(cards.length).toBe(0);
  });
});

describe('resolveMcxCard', () => {
  const card = { exchange: 'MCX', symbol: 'GOLD', date: DATE, at: NOW, bias: 'bullish', side: 'FUT', strike: null, entry: 125_000, sl: 123_500, tgt1: 125_600, tgt2: 126_500 };

  it('grades tgt1 on first touch', () => {
    const candles = [
      { at: NOW + 60_000, high: 125_200, low: 124_900, close: 125_100 },
      { at: NOW + 120_000, high: 125_700, low: 125_150, close: 125_600 },
    ];
    const result = resolveMcxCard(card, candles);
    expect(result.status).toBe('tgt1');
    expect(result.r).toBeGreaterThan(0);
    expect(result.tgt2).toBe(false); // tgt2 126,500 never printed
  });

  it('grades sl when the stop range prints first', () => {
    const candles = [{ at: NOW + 60_000, high: 125_100, low: 123_400, close: 123_600 }];
    const result = resolveMcxCard(card, candles);
    expect(result.status).toBe('sl');
    expect(result.r).toBe(-1);
  });

  it('grades ambiguous when one candle touches both', () => {
    const candles = [{ at: NOW + 60_000, high: 125_700, low: 123_400, close: 124_500 }];
    const result = resolveMcxCard(card, candles);
    expect(result.status).toBe('ambiguous');
  });

  it('stays open with no touches and carries the close', () => {
    const candles = [{ at: NOW + 60_000, high: 125_100, low: 124_950, close: 125_050 }];
    const result = resolveMcxCard(card, candles);
    expect(result.status).toBe('open');
    expect(result.closePremium).toBe(125_050);
  });

  it('returns null with no candles (never a guess)', () => {
    expect(resolveMcxCard(card, [])).toBeNull();
  });
});

describe('runMcxCards', () => {
  it('persists MCX cards into the store and dedupes on rerun', async () => {
    const market = { series: [mcxSeries('NATURALGAS', 30_200, 29_986)] };
    const obsPath = '/tmp/mcx-cards-test.json';
    writeFileSync(obsPath, JSON.stringify({ cards: [] }));
    const first = await runMcxCards(market, { obsPath, date: DATE, now: NOW, readFuturesSnapshot });
    const second = await runMcxCards(market, { obsPath, date: DATE, now: NOW + 1000, readFuturesSnapshot });
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    const saved = JSON.parse(readFileSync(obsPath, 'utf8'));
    expect(saved.cards.filter(card => card.exchange === 'MCX').length).toBe(1);
    unlinkSync(obsPath);
  });
});
