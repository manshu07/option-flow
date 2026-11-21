import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { archivedFutures } from '../scripts/slWidthBacktest.mjs';
import { extractContractTimelines, extractUnderlyingTimelines, rowForCard, simulateStopVariant, simulateUnderlyingStopPreview } from './slWidthBacktest.mjs';

const date = '2026-11-18';
const card = {
  id: 'X|2026-11-18', symbol: 'X', date, holdTill: date,
  at: Date.parse(`${date}T09:15:00+05:30`), expiry: '2026-11-26',
  strike: 100, side: 'CE', entry: 100, sl: 80, tgt1: 120, tgt2: 140, bias: 'bullish',
};

function snapshot(session: string, time: string, price: number, dayHigh = price, dayLow = price, next?: { e: string; r: number[][] }) {
  const at = Date.parse(`${session}T${time.slice(0, 2)}:${time.slice(2)}:00+05:30`);
  return {
    date: session,
    t: at,
    series: [{
      s: 'X', e: '2026-11-26', t: at,
      r: [[100, 0, price, 0, 10_000, 9_000, 1_000, 900, price, 30, 0, 0, 0, 0, dayHigh, dayLow]],
      ...(next ? { next } : {}),
    }],
  };
}

async function* archiveSnapshots(items: unknown[]) {
  for (const item of items) yield item;
}

describe('SL-width contract timeline extraction', () => {
  it('prefers raw minutes and fills missing raw contract-minutes from the archive stream', async () => {
    const timelines = await extractContractTimelines([card], () => [date], {
      readRawIndex: async () => ['0915', '0916', '0917'],
      readRawMinute: async (_session, minute) => minute === '0915' ? snapshot(date, minute, 101) : null,
      readArchiveMinutes: async () => archiveSnapshots([
        snapshot(date, '0915', 999), // Raw wins for this minute.
        snapshot(date, '0916', 105), // Missing raw minute is filled from archive.
      ]),
    });

    expect(timelines[0].points.map(point => [point.at, point.price, point.source])).toEqual([
      [card.at, 101, 'raw'],
      [card.at + 60_000, 105, 'archive'],
    ]);
    expect(timelines[0]).toMatchObject({ rawSamples: 1, archiveSamples: 1, sampledMinutes: 2, missingMinutes: 384 });
  });

  it('uses only the card-selected expiry and does not fall back to a wrong next-chain row', async () => {
    const nextCard = { ...card, expiry: '2026-12-31' };
    const wrongNext = snapshot(date, '0915', 50, 50, 50, {
      e: '2026-12-31',
      r: [[101, 0, 150, 0, 5_000, 4_000, 500, 400, 150, 30, 0, 0, 0, 0, 150, 150]],
    });
    expect(rowForCard(nextCard, wrongNext)).toBeNull();
    const validNext = snapshot(date, '0915', 50, 50, 50, {
      e: '2026-12-31',
      r: [[100, 0, 88, 0, 5_000, 4_000, 500, 400, 88, 30, 0, 0, 0, 0, 88, 88]],
    });
    expect(rowForCard(nextCard, validNext)?.[2]).toBe(88);

    const timeline = await extractContractTimelines([nextCard], () => [date], {
      readRawIndex: async () => null,
      readRawMinute: async () => null,
      readArchiveMinutes: async () => archiveSnapshots([wrongNext]),
    });
    expect(timeline[0].points).toEqual([]);
  });

  it('keeps missing minutes missing when neither raw files nor the archive contain the contract', async () => {
    const timelines = await extractContractTimelines([card], () => [date], {
      readRawIndex: async () => ['0915', '0916'],
      readRawMinute: async (_session, minute) => minute === '0915' ? snapshot(date, minute, 100) : null,
      readArchiveMinutes: async () => archiveSnapshots([]),
    });
    expect(timelines[0].points).toHaveLength(1);
    expect(timelines[0]).toMatchObject({ expectedMinutes: 386, sampledMinutes: 1, missingMinutes: 385 });
  });

  it('settles the first stop or target touch in timestamp order, not a later session extreme', () => {
    const baseline = snapshot(date, '0915', 100, 110, 90).series[0].r[0];
    const entryPoint = { at: card.at, date, price: baseline[2], dayHigh: baseline[14], dayLow: baseline[15] };
    const stopFirst = {
      card,
      points: [
        { at: card.at + 120_000, date, price: 130, dayHigh: 130, dayLow: 70 },
        { at: card.at, date, price: 100, dayHigh: 110, dayLow: 90 },
        { at: card.at + 60_000, date, price: 70, dayHigh: 110, dayLow: 70 },
      ], // Deliberately unsorted input; replay must sort before deciding.
    };
    expect(simulateStopVariant(stopFirst, { kind: 'fixed' })).toMatchObject({ status: 'sl', r: -1, hitAt: card.at + 60_000 });

    const targetFirst = {
      card,
      points: [entryPoint,
        { at: card.at + 60_000, date, price: 125, dayHigh: 125, dayLow: 90 },
        { at: card.at + 120_000, date, price: 70, dayHigh: 125, dayLow: 70 }],
    };
    expect(simulateStopVariant(targetFirst, { kind: 'fixed' })).toMatchObject({ status: 'tgt1', r: 1, hitAt: card.at + 60_000 });

    const preEntryExtremeOnly = {
      card,
      points: [
        { at: card.at - 60_000, date, price: 100, dayHigh: 130, dayLow: 70 },
        { at: card.at, date, price: 100, dayHigh: 130, dayLow: 70 },
        { at: card.at + 60_000, date, price: 100, dayHigh: 130, dayLow: 70 },
      ],
    };
    expect(simulateStopVariant(preEntryExtremeOnly, { kind: 'fixed' }).status).toBe('open');
  });

  it('marks same-minute opposing touches ambiguous and close-exits unresolved cards at the last sample', () => {
    const entryPoint = { at: card.at, date, price: 100, dayHigh: 110, dayLow: 90 };
    const both = { card, points: [entryPoint, { at: card.at + 60_000, date, price: 100, dayHigh: 125, dayLow: 70 }] };
    expect(simulateStopVariant(both, { kind: 'fixed' })).toMatchObject({ status: 'ambiguous', r: -1 });

    const open = { card, points: [entryPoint, { at: card.at + 60_000, date, price: 105, dayHigh: 110, dayLow: 90 }] };
    expect(simulateStopVariant(open, { kind: 'fixed', closeExit: true })).toMatchObject({ status: 'close-exit', r: 0.25, hitAt: card.at + 60_000 });
  });

  it('renormalizes scaled stop R and arms a breakeven trail only before its stop can hit', () => {
    const entryPoint = { at: card.at, date, price: 100, dayHigh: 110, dayLow: 90 };
    const scaled = { card, points: [entryPoint, { at: card.at + 60_000, date, price: 120, dayHigh: 120, dayLow: 90 }] };
    expect(simulateStopVariant(scaled, { kind: 'scaled', multiple: 0.75 })).toMatchObject({ status: 'tgt1', stop: 85, risk: 15, r: 1.33 });

    const trailed = { card, points: [entryPoint,
      { at: card.at + 60_000, date, price: 112, dayHigh: 112, dayLow: 100 },
      { at: card.at + 120_000, date, price: 100, dayHigh: 112, dayLow: 100 }] };
    expect(simulateStopVariant(trailed, { kind: 'breakeven', armR: 0.5 })).toMatchObject({ status: 'breakeven', armedAt: card.at + 60_000, hitAt: card.at + 120_000, r: 0 });

    const sameMinuteTrail = { card, points: [{ ...entryPoint, dayHigh: 105 }, { at: card.at + 60_000, date, price: 100, dayHigh: 112, dayLow: 95 }] };
    expect(simulateStopVariant(sameMinuteTrail, { kind: 'breakeven', armR: 0.5 }).status).toBe('ambiguous');
  });

  it('streams only requested archived futures symbols', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-width-futures-'));
    try {
      const file = path.join(root, 'archive.json.gz');
      const selected = { symbol: 'X', session: date, months: [{ date: '2026-11-26', candles: [{ at: card.at, close: 99 }] }] };
      const other = { symbol: 'Y', session: date, months: [{ date: '2026-11-26', candles: [] }] };
      fs.writeFileSync(file, gzipSync(JSON.stringify({ date, futures: { X: selected, Y: other }, minutes: {} })));
      const rows = [];
      for await (const entry of archivedFutures(file, new Set(['X']))) rows.push(entry);
      expect(rows).toEqual([['X', selected]]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads raw futures first and fills a missing symbol from archived futures', async () => {
    const withLevel = { ...card, needs: { sl: { level: 95 } } };
    const raw = { symbol: 'X', session: date, months: [{ date: '2026-11-26', candles: [{ at: card.at, close: 90 }] }] };
    const archived = { symbol: 'X', session: date, months: [{ date: '2026-11-26', candles: [{ at: card.at, close: 110 }] }] };
    const timelines = await extractUnderlyingTimelines([withLevel], () => [date], {
      readRawFutures: async () => raw,
      readArchiveFutures: async () => archiveSnapshots([['X', archived]]),
    });
    expect(timelines[0]).toMatchObject({ rawCandles: 1, archiveCandles: 0, candles: [{ close: 90 }] });

    const fallback = await extractUnderlyingTimelines([withLevel], () => [date], {
      readRawFutures: async () => null,
      readArchiveFutures: async () => archiveSnapshots([['X', archived]]),
    });
    expect(fallback[0]).toMatchObject({ rawCandles: 0, archiveCandles: 1, candles: [{ close: 110 }] });
  });

  it('previews underlying breach, premium backstop, open outcome, and same-minute ambiguity', () => {
    const withLevel = { ...card, needs: { sl: { level: 95 } } };
    const futures = { candles: [{ at: card.at, close: 94 }], expectedCandles: 1, missingCandles: 0 };
    const emptyOptions = { card: withLevel, points: [] };
    expect(simulateUnderlyingStopPreview(emptyOptions, futures)).toMatchObject({ status: 'sl', slTrigger: 'underlying', slSpot: 95 });

    const noBreach = { candles: [{ at: card.at, close: 100 }], expectedCandles: 1, missingCandles: 0 };
    expect(simulateUnderlyingStopPreview({ card: withLevel, points: [{ at: card.at + 60_000, date, price: 25, dayHigh: 100, dayLow: 25 }] }, noBreach))
      .toMatchObject({ status: 'sl', slTrigger: 'premium' });
    expect(simulateUnderlyingStopPreview(emptyOptions, noBreach)).toMatchObject({ status: 'open' });
    expect(simulateUnderlyingStopPreview({ card: withLevel, points: [{ at: card.at + 60_000, date, price: 125, dayHigh: 125, dayLow: 90 }] }, futures))
      .toMatchObject({ status: 'ambiguous', slTrigger: null });
  });
});
