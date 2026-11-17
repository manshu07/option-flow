import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveCard, runJournal, trackCardFollowThrough, withJournalStoreLock } from './journal.mjs';
import { retainObservations } from './strikeAdvisor.mjs';
import { backfillJournalFollowThrough } from '../scripts/backfillJournalArchive.mjs';

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

describe('post-call follow-through evidence', () => {
  const expiry = '2026-11-23';
  const from = closeAt(DATE) - 3 * 60_000;
  const followCard = (overrides = {}) => card({ at: from, expiry, entry: 100, sl: 55, tgt1: 155, tgt2: 190, ...overrides });
  const reading = (at, premium, high = premium, low = premium, overrides = {}) => ({
    date: DATE, t: at,
    series: [{ s: 'TMPV', e: expiry, t: at, r: [optionRow(265, 0, premium, high, low)], ...overrides }],
  });

  it('keeps tracking TGT2 and a later stop without changing the first-exit journal result', () => {
    const candidate = followCard();
    const minutes = [reading(from, 100), reading(from + 60_000, 160), reading(from + 120_000, 195), reading(from + 180_000, 50)];
    expect(resolveCard(candidate, minutes)).toMatchObject({ status: 'tgt1', tgt2: false, hitAt: from + 60_000 });
    const result = trackCardFollowThrough(candidate, minutes);
    expect(result).toMatchObject({
      version: 1, source: 'raw', sequence: 'target-first', coverage: 'complete', sampleCount: 4, expectedMinutes: 4, missingMinutes: 0,
      range: { open: 100, high: 195, low: 50, close: 50 },
      touches: { tgt1: { at: from + 60_000, source: 'ltp' }, tgt2: { at: from + 120_000, source: 'ltp' }, sl: { at: from + 180_000, source: 'ltp' } },
    });
  });

  it('records post-SL targets as later price movement, including for bought puts', () => {
    const candidate = followCard({ bias: 'bearish', side: 'PE' });
    const minutes = [100, 50, 160, 195].map((premium, index) => ({
      date: DATE, t: from + index * 60_000,
      series: [{ s: 'TMPV', e: expiry, r: [optionRow(265, 1, premium)] }],
    }));
    expect(trackCardFollowThrough(candidate, minutes)).toMatchObject({
      sequence: 'sl-first', range: { high: 195, low: 50 },
      touches: { sl: { at: from + 60_000 }, tgt1: { at: from + 120_000 }, tgt2: { at: from + 180_000 } },
    });
  });

  it('does not use cumulative extremes reached before the observation as post-call touches', () => {
    const minutes = [
      reading(from - 60_000, 100, 250, 20),
      reading(from, 100, 250, 20),
      reading(from + 60_000, 110, 250, 20),
      reading(from + 120_000, 90, 250, 20),
      reading(from + 180_000, 105, 250, 20),
    ];
    expect(trackCardFollowThrough(followCard(), minutes)).toMatchObject({
      sequence: 'none-observed', range: { open: 100, high: 110, low: 90, close: 105 },
      touches: { sl: null, tgt1: null, tgt2: null },
    });
  });

  it('uses only provably new cumulative extremes and marks an unknown SL/target order ambiguous', () => {
    const minutes = [reading(from, 100, 110, 90), reading(from + 60_000, 120, 200, 50)];
    expect(trackCardFollowThrough(followCard(), minutes)).toMatchObject({
      sequence: 'ambiguous', coverage: 'partial', range: { high: 200, low: 50 },
      touches: {
        sl: { after: from, at: from + 60_000, source: 'day-range' },
        tgt1: { after: from, at: from + 60_000, source: 'day-range' },
        tgt2: { after: from, at: from + 60_000, source: 'day-range' },
      },
    });
  });

  it('does not attribute an unbounded first high/low or a pre-call data gap to the call', () => {
    const minutes = [reading(from - 120_000, 100, 110, 90), reading(from + 60_000, 100, 250, 20), reading(from + 120_000, 110, 250, 20)];
    expect(trackCardFollowThrough(followCard(), minutes)).toMatchObject({ touches: { sl: null, tgt1: null, tgt2: null } });
    const absentExtremes = reading(from, 100);
    absentExtremes.series[0].r[0][14] = null;
    absentExtremes.series[0].r[0][15] = null;
    expect(trackCardFollowThrough(followCard(), [absentExtremes, reading(from + 60_000, 110, 250, 20)])).toMatchObject({
      range: { high: 110, low: 100 }, touches: { sl: null, tgt1: null, tgt2: null },
    });
  });

  it('ignores other expiries, missing rows, and series read before the call even in a later build', () => {
    const minutes = [
      reading(from, 300, 300, 20, { e: '2026-11-30' }),
      reading(from + 60_000, 300, 300, 20, { t: from - 1 }),
      reading(from + 120_000, 300, 300, 20, { r: [optionRow(270, 0, 300), optionRow(265, 1, 300)] }),
    ];
    expect(trackCardFollowThrough(followCard(), minutes)).toMatchObject({
      coverage: 'missing', sampleCount: 0, missingMinutes: 4, firstAt: null, lastAt: null,
      range: { open: null, high: null, low: null, close: null }, touches: { sl: null, tgt1: null, tgt2: null },
    });
  });

  it('reports capture gaps, includes the closing minute, and ignores other dates and post-close data', () => {
    const closing = closeAt(DATE) + 3_000;
    const minutes = [
      reading(from, 100), reading(from, 100), reading(from + 120_000, 120), reading(closing, 130),
      reading(closeAt(DATE) + 60_000, 300), { ...reading(from + 60_000, 300), date: '2026-11-17' },
    ];
    expect(trackCardFollowThrough(followCard(), minutes, { source: 'archive' })).toMatchObject({
      source: 'archive', coverage: 'partial', sampleCount: 3, expectedMinutes: 4, missingMinutes: 1, lastAt: closing,
      range: { open: 100, high: 130, low: 100, close: 130 }, touches: { sl: null, tgt1: null, tgt2: null },
    });
  });

  it('keeps overlapping evidence intervals ambiguous even when captures have different timestamps', () => {
    const middle = reading(from + 60_000, 50, 100, 50);
    middle.series[0].r[0][14] = null;
    const minutes = [reading(from, 100, 100, 100), middle, reading(from + 120_000, 120, 200, 50)];
    expect(trackCardFollowThrough(followCard(), minutes)).toMatchObject({ sequence: 'ambiguous' });
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

  it('enriches an existing outcome without changing its fields or losing newly written cards', async () => {
    const date = '2026-11-19';
    const at = closeAt(date) - 120_000;
    const obsPath = join(tempDir(), 'observations.json');
    const legacy = { status: 'tgt1', r: 1.22, tgt2: false, mfe: 3, mae: 0, hitAt: at + 60_000, computedAt: at + 60_000, minutes: 2 };
    const original = card({ date, at, expiry: '2026-11-23', outcome: legacy });
    const concurrent = card({ id: 'NEW', symbol: 'NEW', date, at, expiry: '2026-11-23' });
    writeFileSync(obsPath, JSON.stringify({ schema: 1, cards: [original] }));
    let appended = false;
    const readMinute = async (_date, hhmm) => {
      if (!appended) { writeFileSync(obsPath, JSON.stringify({ schema: 1, cards: [original, concurrent] })); appended = true; }
      const premium = hhmm === '1538' ? 5 : hhmm === '1539' ? 8 : hhmm === '1540' ? 10 : null;
      return premium == null ? null : { date, t: at + (Number(hhmm.slice(2)) - 38) * 60_000, series: [{ s: 'TMPV', e: '2026-11-23', r: [optionRow(265, 0, premium)] }] };
    };
    const result = await runJournal({ obsPath, readMinute, now: closeAt(date) + 60_000 });
    expect(result).toMatchObject({ written: 1, resolved: 0 });
    const stored = JSON.parse(readFileSync(obsPath, 'utf8')).cards;
    const { followThrough, ...preserved } = stored[0].outcome;
    expect(preserved).toEqual(legacy);
    expect(followThrough.touches.tgt2.at).toBe(closeAt(date));
    expect(stored[1]).toEqual(concurrent);
    expect(JSON.parse(readFileSync(obsPath, 'utf8')).schema).toBe(1);
  });

  it('adds through-close tracking to new outcomes in the existing end-of-day pass', async () => {
    const date = '2026-11-23';
    const at = closeAt(date) - 120_000;
    const obsPath = join(tempDir(), 'observations.json');
    writeFileSync(obsPath, JSON.stringify({ cards: [card({ date, at, expiry: '2026-11-30' })] }));
    const readMinute = async (_date, hhmm) => {
      const premium = hhmm === '1538' ? 5 : hhmm === '1539' ? 8 : hhmm === '1540' ? 10 : null;
      return premium == null ? null : {
        date, t: at + (Number(hhmm.slice(2)) - 38) * 60_000 + 3_000,
        series: [{ s: 'TMPV', e: '2026-11-30', r: [optionRow(265, 0, premium)] }],
      };
    };
    const send = vi.fn(async () => ({ sent: true }));
    expect(await runJournal({ obsPath, readMinute, now: closeAt(date) + 60_000, send })).toMatchObject({ written: 1, resolved: 1 });
    const stored = JSON.parse(readFileSync(obsPath, 'utf8')).cards[0];
    expect(stored.outcome).toMatchObject({ status: 'tgt1', r: 1.22, tgt2: false });
    expect(stored.outcome.followThrough).toMatchObject({
      coverage: 'complete', sampleCount: 3, range: { open: 5, high: 10, low: 5, close: 10 },
      touches: { tgt2: { at: closeAt(date) + 3_000 } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('1 TGT1');
  });

  it('can upgrade missing evidence in a later pass when raw captures become available', async () => {
    const date = '2026-11-24';
    const at = closeAt(date) - 60_000;
    const candidate = card({ date, at, expiry: '2026-11-30' });
    const legacy = { status: 'open', r: null, followThrough: trackCardFollowThrough(candidate, []) };
    const obsPath = join(tempDir(), 'observations.json');
    writeFileSync(obsPath, JSON.stringify({ cards: [{ ...candidate, outcome: legacy }] }));
    const readMinute = async (_date, hhmm) => hhmm === '1539' || hhmm === '1540'
      ? { date, t: hhmm === '1539' ? at : closeAt(date), series: [{ s: 'TMPV', e: '2026-11-30', r: [optionRow(265, 0, 10)] }] }
      : null;
    expect(await runJournal({ obsPath, readMinute, now: closeAt('2026-11-25') })).toMatchObject({ written: 1 });
    expect(JSON.parse(readFileSync(obsPath, 'utf8')).cards[0].outcome).toMatchObject({ status: 'open', r: null, followThrough: { coverage: 'complete' } });
  });
});

describe('offline follow-through backfill', () => {
  it('supports raw files, dry-runs, backups, and idempotent additive updates', () => {
    const dir = tempDir();
    const raw = join(dir, DATE);
    mkdirSync(raw);
    const candidate = card({ expiry: '2026-11-23', outcome: { status: 'tgt1', r: 1.22, tgt2: false } });
    const obsPath = join(dir, 'observations.json');
    const original = JSON.stringify({ cards: [candidate], metadata: { keep: true } });
    writeFileSync(obsPath, original);
    const args = { date: DATE, inputPath: raw, obsPath, now: closeAt('2026-11-17') + 60_000 };
    writeFileSync(join(raw, 'index.json'), JSON.stringify([['0915', AT], ['0916', AT + 60_000]]));
    for (const [hhmm, at, premium] of [['0915', AT, 5], ['0916', AT + 60_000, 10]]) {
      writeFileSync(join(raw, `${hhmm}.json`), JSON.stringify({ date: DATE, t: at, series: [{ s: 'TMPV', e: '2026-11-23', r: [optionRow(265, 0, premium)] }] }));
    }
    expect(backfillJournalFollowThrough({ ...args, dryRun: true })).toMatchObject({ updated: 1, backupPath: null });
    expect(readFileSync(obsPath, 'utf8')).toBe(original);
    const result = backfillJournalFollowThrough(args);
    expect(result.updated).toBe(1);
    expect(readFileSync(result.backupPath, 'utf8')).toBe(original);
    const stored = JSON.parse(readFileSync(obsPath, 'utf8'));
    expect(stored.metadata).toEqual({ keep: true });
    const { followThrough, ...legacy } = stored.cards[0].outcome;
    expect(legacy).toEqual(candidate.outcome);
    expect(followThrough).toMatchObject({ source: 'raw', coverage: 'partial', touches: { tgt2: { at: AT + 60_000 } } });
    expect(backfillJournalFollowThrough(args)).toMatchObject({ updated: 0, backupPath: null });
    writeFileSync(join(raw, 'index.json'), JSON.stringify([['0915', AT]]));
    expect(backfillJournalFollowThrough(args)).toMatchObject({ updated: 0 });
    expect(JSON.parse(readFileSync(obsPath, 'utf8')).cards[0].outcome.followThrough.sampleCount).toBe(2);
    expect(() => withJournalStoreLock(obsPath, () => backfillJournalFollowThrough(args))).toThrow();
    expect(existsSync(`${obsPath}.journal.lock`)).toBe(false);
    expect(() => backfillJournalFollowThrough({ ...args, now: Date.parse('2026-11-17T04:00:00Z') })).toThrow('outside market hours');
  });

  it('enriches archived history offline and rejects the wrong session without writes', () => {
    const dir = tempDir();
    const inputPath = join(dir, 'day.json.gz');
    const obsPath = join(dir, 'observations.json');
    const candidate = card({ expiry: '2026-11-23', outcome: { status: 'open', r: null, tgt2: false } });
    const minute = { date: DATE, t: AT + 60_000, series: [{ s: 'TMPV', e: '2026-11-23', r: [optionRow(265, 0, 10)] }] };
    writeFileSync(inputPath, gzipSync(JSON.stringify({ date: DATE, minutes: { '0916': minute } })));
    writeFileSync(obsPath, JSON.stringify({ cards: [candidate] }));
    const args = { date: DATE, inputPath, obsPath, now: closeAt('2026-11-17') + 60_000 };
    const result = backfillJournalFollowThrough(args);
    expect(result.changes[0].followThrough).toMatchObject({ source: 'archive', touches: { tgt1: { at: AT + 60_000 }, tgt2: { at: AT + 60_000 } } });
    const original = readFileSync(obsPath, 'utf8');
    expect(() => backfillJournalFollowThrough({ ...args, date: '2026-11-17' })).toThrow('requested session');
    expect(readFileSync(obsPath, 'utf8')).toBe(original);
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
