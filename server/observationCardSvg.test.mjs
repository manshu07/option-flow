import { describe, expect, it } from 'vitest';
import { observationCaption, renderObservationCardSvg } from './observationCardSvg.mjs';

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
    expect(svg).toContain('25,291.15');
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
    expect(caption).toContain('🔍 <b>OBSERVATION</b> · NIFTY 25150CE · 09:45 IST');
    expect(caption).toContain('Bias: <b>bullish</b> · quality <b>82%</b> · strike pick 74%');
    expect(caption).toContain('• Entry ~<b>1003.30</b> · spot 25291.15 (+0.6%)');
    expect(caption).toContain('• Support 25100 PE · Resistance 25200 CE');
    expect(caption).toContain('captured-data observation · not advice · final call yours');
    expect(caption).not.toContain('<b>Live</b>');
  });

  it('adds a live line only for readings available at send time', () => {
    const caption = observationCaption({ ...card, live: { spot: 25_291.15, future: 25_300, option: 1_064 } });
    expect(caption).toContain('<b>Live</b> · spot 25291.15 · fut 25300.00 · opt ₹1064.00 (▲ +6% vs entry)');
    expect(observationCaption({ ...card, live: {} })).not.toContain('<b>Live</b>');
  });

  it('escapes dynamic fields in the HTML caption', () => {
    const caption = observationCaption({ ...card, symbol: '<script>&' });
    expect(caption).toContain('&lt;script&gt;&amp;');
    expect(caption).not.toContain('<script>&');
  });
});
