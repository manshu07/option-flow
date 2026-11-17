import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCard, runJournal } from './journal.mjs';
import { retainObservations } from './strikeAdvisor.mjs';

const DATE = '2026-11-16';
const AT = Date.parse(`${DATE}T03:45:00Z`); // 09:15 IST
const closeAt = date => Date.parse(`${date}T10:10:00Z`); // 15:40 IST
const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'order-flow-journal-'));
  tempDirs.push(dir);
  return dir;
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: `TMPV|${DATE}`,
    at: AT,
    date: DATE,
    symbol: 'TMPV',
    bias: 'bullish',
    side: 'CE',
    strike: 265,
    entry: 5,
    sl: 2.75,
    tgt1: 7.75,
    tgt2: 9.5,
    quality: 0.9,
    ...overrides,
  };
}

type TestRow = Array<number | null>;

function optionRow(strike: number, side: number, premium: number, high = premium, low = premium): TestRow {
  // Real marketFile row layout (18 fields): [strike, side, ltp, prevClose, oi,
  // prevOi, volume, prevVolume, avgPrice, iv, bid, ask, bidQty, askQty,
  // dayHigh(14), dayLow(15), lastTradeAt, delta]
  return [strike, side, premium, premium, 1_000, 900, 1, 0, 0, null, 0, 0, 0, 0, high, low, null, null];
}

function snapshot(date: string, t: number, rows: TestRow[]) {
  return { date, t, series: [{ s: 'TMPV', r: rows }] };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveCard', () => {
  it('settles a bullish card at TGT1 before a later stop', () => {
    const bullish = card();
    const result = resolveCard(bullish, [
      snapshot(DATE, AT, [optionRow(265, 0, 5)]),
      snapshot(DATE, AT + 60_000, [optionRow(265, 0, 8)]),
      snapshot(DATE, AT + 120_000, [optionRow(265, 0, 2)]),
    ]);

    expect(result).toMatchObject({ status: 'tgt1', r: 1.22, tgt2: false, hitAt: AT + 60_000, minutes: 2 });
  });

  it('settles a bearish card at SL with R -1', () => {
    const bearish = card({ bias: 'bearish', side: 'PE', strike: 260 });
    const result = resolveCard(bearish, [
      snapshot(DATE, AT, [optionRow(260, 1, 5)]),
      snapshot(DATE, AT + 60_000, [optionRow(260, 1, 2.5)]),
    ]);

    expect(result).toMatchObject({ status: 'sl', r: -1, hitAt: AT + 60_000, minutes: 2 });
  });

  it('marks SL and TGT1 crossed in the same minute snapshot ambiguous', () => {
    const result = resolveCard(card(), [
      snapshot(DATE, AT, [optionRow(265, 0, 5, 5.2, 4.8)]),
      snapshot(DATE, AT + 60_000, [optionRow(265, 0, 5.5, 8, 2.5)]),
    ]);

    expect(result).toMatchObject({ status: 'ambiguous', r: -1, hitAt: AT + 60_000, minutes: 2 });
  });

  it('returns an open outcome with favorable/adverse excursion when no level is hit', () => {
    const result = resolveCard(card(), [
      snapshot(DATE, AT, [optionRow(265, 0, 5)]),
      snapshot(DATE, AT + 60_000, [optionRow(265, 0, 6)]),
      snapshot(DATE, AT + 120_000, [optionRow(265, 0, 4.5)]),
    ]);

    expect(result).toMatchObject({ status: 'open', r: null, mfe: 1, mae: 0.5, tgt2: false, hitAt: null, minutes: 3 });
  });

  it('skips minutes where the option row is absent and continues resolving', () => {
    const result = resolveCard(card(), [
      snapshot(DATE, AT, []),
      snapshot(DATE, AT + 60_000, [optionRow(265, 0, 8)]),
    ]);

    expect(result).toMatchObject({ status: 'tgt1', hitAt: AT + 60_000, minutes: 2 });
  });

  it('does not resolve a card against snapshots from a different date', () => {
    const result = resolveCard(card(), [
      snapshot('2026-11-17', AT + 86_400_000, [optionRow(265, 0, 12)]),
    ]);

    expect(result).toBeNull();
  });
});

describe('runJournal', () => {
  it('reads one date pass, persists outcomes atomically, and sends one summary', async () => {
    const dir = tempDir();
    const obsPath = join(dir, 'observations.json');
    const stopCard = card({ id: 'TMPV|DATE|PE', side: 'PE', strike: 260, bias: 'bearish' });
    writeFileSync(obsPath, JSON.stringify({ cards: [card(), stopCard] }));
    const fixtures = new Map([
      ['0915', snapshot(DATE, AT, [optionRow(265, 0, 5), optionRow(260, 1, 5)])],
      ['0916', snapshot(DATE, AT + 60_000, [optionRow(265, 0, 8), optionRow(260, 1, 2.5)])],
    ]);
    const readMinute = vi.fn(async (_date: string, hhmm: string) => fixtures.get(hhmm) ?? null);
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    const beforeClose = await runJournal({ obsPath, readMinute, now: closeAt(DATE) - 60_000, send });
    expect(beforeClose.skipped).toBe('before close');
    expect(readMinute).not.toHaveBeenCalled();

    const first = await runJournal({ obsPath, readMinute, now: closeAt(DATE), send });
    expect(first).toMatchObject({ date: DATE, written: 2, resolved: 2 });
    expect(readMinute).toHaveBeenCalledTimes(386); // one ascending snapshot pass, not one pass per card
    const stored = JSON.parse(readFileSync(obsPath, 'utf8')).cards;
    expect(stored.map((item: { outcome: { status: string } }) => item.outcome.status)).toEqual(['tgt1', 'sl']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('2 resolved');

    const second = await runJournal({ obsPath, readMinute, now: closeAt(DATE) + 60_000, send });
    expect(second.skipped).toBe('already ran');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('day rollover and history', () => {
  it('finalizes an unsettled card open on its own date, ignoring next-day target prices', async () => {
    const dir = tempDir();
    const obsPath = join(dir, 'observations.json');
    const previousDate = '2026-11-17';
    const at = Date.parse(`${previousDate}T03:45:00Z`);
    const closing = Date.parse(`${previousDate}T10:10:00Z`);
    const historical = card({ id: `TMPV|${previousDate}`, date: previousDate, at });
    writeFileSync(obsPath, JSON.stringify({ cards: [historical] }));
    const readMinute = vi.fn(async (date: string, hhmm: string) => {
      if (date !== previousDate || hhmm === '0916') return snapshot('2026-11-18', closeAt('2026-11-18'), [optionRow(265, 0, 12)]);
      if (hhmm === '0915') return snapshot(previousDate, at, [optionRow(265, 0, 5)]);
      if (hhmm === '1540') return snapshot(previousDate, closing, [optionRow(265, 0, 6.5)]);
      return null;
    });

    const result = await runJournal({ obsPath, readMinute, now: closeAt('2026-11-18') });
    expect(result).toMatchObject({ date: '2026-11-18', written: 1, resolved: 0 });
    expect(readMinute).toHaveBeenCalledTimes(386);
    expect(readMinute.mock.calls.every(([date]) => date === previousDate)).toBe(true);
    const stored = JSON.parse(readFileSync(obsPath, 'utf8')).cards[0];
    expect(stored.outcome).toMatchObject({ status: 'open', r: null, mfe: 1.5, mae: 0, computedAt: closing });
  });

  it('never evicts unresolved cards to satisfy the 50-card target', () => {
    const unresolved = Array.from({ length: 51 }, (_, index) => ({
      id: `U${index}`, symbol: `U${index}`, date: DATE, at: AT,
    }));
    const resolved = [
      { id: 'newest-resolved', symbol: 'NEW', date: DATE, outcome: { status: 'open' } },
      { id: 'older-resolved', symbol: 'OLD', date: DATE, outcome: { status: 'sl' } },
    ];

    const kept = retainObservations([...unresolved, ...resolved], 50);
    expect(kept).toHaveLength(51);
    expect(kept.every(item => !item.outcome)).toBe(true);

    const resolvedOnly = retainObservations([
      { id: 'newest', symbol: 'NEWEST', date: DATE, outcome: { status: 'sl' } },
      { id: 'middle', symbol: 'MIDDLE', date: DATE, outcome: { status: 'tgt1' } },
      { id: 'oldest', symbol: 'OLDEST', date: DATE, outcome: { status: 'open' } },
    ], 2);
    expect(resolvedOnly.map(item => item.symbol)).toEqual(['NEWEST', 'MIDDLE']);
  });
});
