import { describe, expect, it } from 'vitest';
import { formatHistoryRefreshSummary, historyRefreshDue, futureCaptureBelowCoverage, refreshWindow, runHistoryRefresh, istParts } from './historyRefresh.mjs';

const at = (iso: string) => Date.parse(`${iso}+05:30`);

describe('historyRefreshDue', () => {
  it('fires once a day after 19:30 IST, never before', () => {
    expect(historyRefreshDue(at('2026-11-19T19:29:00'))).toBe(false);
    expect(historyRefreshDue(at('2026-11-19T19:30:00'))).toBe(true);
    expect(historyRefreshDue(at('2026-11-19T23:10:00'))).toBe(true);
    expect(historyRefreshDue(at('2026-11-19T20:00:00'), '2026-11-19')).toBe(false);
    expect(historyRefreshDue(at('2026-11-20T19:35:00'), '2026-11-19')).toBe(true);
    expect(historyRefreshDue(Number.NaN)).toBe(false);
  });

  it('reads the IST day, not the UTC one', () => {
    // 20:00 IST is 14:30 UTC the same day; 00:30 IST is the previous UTC day.
    expect(istParts(at('2026-11-19T20:00:00')).date).toBe('2026-11-19');
    expect(istParts(at('2026-11-19T00:30:00')).date).toBe('2026-11-19');
  });
});

describe('refreshWindow', () => {
  it('asks for a week back so a missed evening self-heals', () => {
    expect(refreshWindow(at('2026-11-19T19:40:00'))).toEqual({ from: '2026-11-12', to: '2026-11-19' });
  });
});

describe('today futures coverage gate', () => {
  it('counts unique current-session minute candles and applies the 60 percent threshold', () => {
    const session = '2026-11-19';
    const candles = [0, 1, 2, 3, 4, 4].map(minute => ({ at: at(`2026-11-19T09:${String(15 + minute).padStart(2, '0')}:00`) }));
    candles.push({ at: at('2026-11-18T09:15:00') });
    expect(futureCaptureBelowCoverage(candles, session, 10)).toBe(true);
    expect(futureCaptureBelowCoverage([...candles, ...[5, 6].map(minute => ({ at: at(`2026-11-19T09:${String(15 + minute).padStart(2, '0')}:00`) }))], session, 10)).toBe(false);
    expect(futureCaptureBelowCoverage([], session, 0)).toBe(false);
  });
});

describe('runHistoryRefresh', () => {
  it('runs the three steps in order and keeps going after a failure', async () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const logs: string[] = [];
    const result = await runHistoryRefresh({
      root: '/tmp',
      at: at('2026-11-19T19:40:00'),
      log: line => logs.push(line),
      run: async (script, args) => {
        calls.push({ script, args });
        if (script.includes('fetchBhavcopy')) throw new Error('NSE 503');
        return 0;
      },
    });
    expect(calls.map(c => c.script)).toEqual([
      'scripts/fetchBhavcopy.mjs',
      'scripts/accumulateFutures.mjs',
      'scripts/ingestFutStats.mjs',
    ]);
    expect(calls[0].args).toEqual(['2026-11-12', '2026-11-19']);
    expect(result.results[0].error).toContain('NSE 503');
    expect(result.results[1].code).toBe(0);
    expect(logs.join('\n')).toContain('bhavcopy failed');
  });

  it('runs the in-process today-backfill as the final ordered refresh step', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await runHistoryRefresh({
      root: '/tmp',
      at: at('2026-11-19T19:40:00'),
      log: line => logs.push(line),
      run: async script => { calls.push(script); return 0; },
      todayBackfill: async window => { calls.push(`today-backfill:${window.to}`); return 105; },
    });
    expect(calls).toEqual([
      'scripts/fetchBhavcopy.mjs',
      'scripts/accumulateFutures.mjs',
      'scripts/ingestFutStats.mjs',
      'today-backfill:2026-11-19',
    ]);
    expect(result.results.at(-1)).toEqual({ step: 'today-backfill', code: 0, symbols: 105 });
    expect(logs.at(-1)).toBe('history refresh today-backfill=105 symbols');
    expect(formatHistoryRefreshSummary(result.results)).toBe('history refresh done: bhavcopy=0 capture=0 fut-stats=0 today-backfill=105');
  });
});
