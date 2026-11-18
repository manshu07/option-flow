import { describe, expect, it } from 'vitest';
import { observationCaption, observationSubscriberCaption, renderObservationCardSvg } from './observationCardSvg.mjs';

const card = {
  id: 'NIFTY|2026-11-16',
  at: Date.parse('2026-11-16T04:15:00Z'),
  date: '2026-11-16',
  symbol: 'NIFTY',
  spot: 25_291.14999,
  spotChangePct: 0.58123,
  bias: 'bullish',
  side: 'CE',
  strike: 25_150,
  expiry: '2026-11-19',
  entry: 1_003.2999877929688,
  sl: 551.8149932861328,
  tgt1: 1_555.114990234375,
  tgt2: 1_906.269989013672,
  tsl: 'after TGT1, trail the stop to entry (cost)',
  support: { strike: 25_100, oi: 2_500_000, changePct: 3.1415926 },
  resistance: { strike: 25_200, oi: 3_500_000, changePct: -1.234567 },
  quality: 0.82,
  strikePickProbability: 0.74,
  oiChangePct: 4.2,
  disclaimer: 'Educational observation; not trade advice.',
};

describe('Observation card SVG', () => {
  it('renders the latest observation snapshot with prices rounded to two decimals', () => {
    const svg = renderObservationCardSvg(card);

    expect(svg).toContain('<svg');
    expect(svg).toContain('NIFTY 25150C');
    expect(svg).toContain('25291.15');
    expect(svg).toContain('19-Nov (3 DTE) · 16-Nov 09:45 IST');
    expect(svg).toContain('1003.30');
    expect(svg).toContain('551.81');
    expect(svg).toContain('1555.11');
    expect(svg).toContain('1906.27');
    expect(svg).toContain('+0.58%');
    expect(svg).toContain('not trade advice');
    expect(svg).not.toContain('1003.2999877929688');
  });

  it('escapes text fields before inserting them into the SVG', () => {
    const svg = renderObservationCardSvg({ ...card, symbol: '<script>&' });
    expect(svg).toContain('&lt;script&gt;&amp;');
    expect(svg).not.toContain('<script>&');
  });

  it('creates a concise Telegram caption', () => {
    const caption = observationCaption(card);
    expect(caption).toContain('🔍 <b>OBSERVATION</b> · NIFTY 25150CE · 19-Nov (3 DTE) · 16-Nov 09:45 IST');
    expect(caption).toContain('Bias: <b>bullish</b> · quality <b>82%</b> · strike pick 74%');
    expect(caption).toContain('• Entry ~<b>1003.30</b> · spot 25291.15 (+0.6%)');
    expect(caption).toContain('• Support 25100 PE · Resistance 25200 CE');
    expect(caption).toContain('captured-data observation · not advice · final call yours');
    expect(caption).not.toContain('<b>Live</b>');
    expect(caption).not.toContain('ago');
  });

  it('adds plain dealer flow and a theta warning to the caption and SVG', () => {
    const gammaCard = {
      ...card,
      expiry: '2026-11-22',
      gamma: {
        regime: 'gamma-long', flipLevel: 25_180, pin: '25250CE',
        notes: ['Wall-based stop sits beyond the gamma flip; dealers may accelerate the move.'],
      },
    };
    const caption = observationCaption(gammaCard);
    const svg = renderObservationCardSvg(gammaCard);
    const flow = '📐 Dealer flow: RANGE above 25,180 — breakouts likely to fade · pin 25250CE';
    const theta = '⏳ 6 DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.';

    expect(caption).toContain('22-Nov (6 DTE)');
    expect(caption).toContain(flow);
    expect(caption).toContain(theta);
    expect(caption).not.toContain('Γ regime');
    expect(caption.toLowerCase()).not.toContain('gamma');
    expect(caption).toContain('dealer-flow level');
    expect(svg).toContain('22-Nov (6 DTE) · 16-Nov 09:45 IST');
    expect(svg).toContain(flow);
    expect(svg).toContain(theta);
  });

  it('uses the stronger theta warning at two DTE and omits dealer flow without a flip', () => {
    const caption = observationCaption({
      ...card,
      expiry: '2026-11-18',
      gamma: { regime: 'gamma-long', flipLevel: null, pin: null, notes: [] },
    });
    expect(caption).toContain('⏳ 2 DTE — expiry-week decay is brutal; treat as a same-day trade only.');
    expect(caption).not.toContain('Dealer flow:');
  });

  it('adds a live line only for readings available at send time', () => {
    const caption = observationCaption({ ...card, live: { spot: 25_291.15, future: 25_300, option: 1_064 } });
    expect(caption).toContain('<b>Live</b> · spot 25291.15 · fut 25300.00 · opt ₹1064.00 (▲ +6% vs entry)');
    expect(observationCaption({ ...card, live: {} })).not.toContain('<b>Live</b>');
  });

  it('adds one owner-only range line for valid ATR, including zero, and omits invalid or legacy values', () => {
    const range = { value: 0, barMinutes: 15, state: 'compressed' };
    const caption = observationCaption({ ...card, atr: range });
    const svg = renderObservationCardSvg({ ...card, atr: range });
    expect(caption).toContain('Range: Futures ATR(15m) 0.00 pts · compressed');
    expect(svg).toContain('Range: Futures ATR(15m) 0.00 pts · compressed');
    expect(observationCaption(card)).not.toContain('Futures ATR');
    expect(renderObservationCardSvg(card)).not.toContain('Futures ATR');
    expect(observationCaption({ ...card, atr: { value: 12, barMinutes: 5, state: 'normal' } })).not.toContain('Futures ATR');
    expect(observationCaption({ ...card, atr: { value: '12', barMinutes: 15, state: 'normal' } })).not.toContain('Futures ATR');
    expect(observationCaption({ ...card, atr: { value: 12, barMinutes: 15, state: 'unknown' } })).not.toContain('Futures ATR');
    expect(renderObservationCardSvg({ ...card, atr: null })).toBe(renderObservationCardSvg(card));
  });

  it('escapes dynamic fields in the HTML caption', () => {
    const caption = observationCaption({ ...card, symbol: '<script>&' });
    expect(caption).toContain('&lt;script&gt;&amp;');
    expect(caption).not.toContain('<script>&');
  });
});

describe('observationSubscriberCaption', () => {
  it('strips quality and attribution while keeping the call details', async () => {
    const text = observationSubscriberCaption({ ...card, quality: 0.93, strikePickProbability: 0.8 });
    expect(text).toContain('NIFTY');
    expect(text).toContain('Entry ~₹');
    expect(text).toContain('SL');
    expect(text).toContain('TGT1');
    expect(text).toContain('not investment advice');
    expect(text).not.toMatch(/quality|jev|watch|advisor|model/i);
  });

  it('keeps the frozen subscriber output exact and independent of ATR', () => {
    const expected = '📌 <b>NIFTY 25150CE</b> · 19-Nov (3 DTE)\nEntry ~₹1003.30 · SL ₹551.81 · TGT1 ₹1555.11 · TGT2 ₹1906.27\n⏳ 3 DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.\n🎓 captured-data observation · not investment advice · /stop to opt out';
    expect(observationSubscriberCaption(card)).toBe(expected);
    expect(observationSubscriberCaption({ ...card, atr: { value: 0, barMinutes: 15, state: 'compressed' } })).toBe(expected);
  });
});
