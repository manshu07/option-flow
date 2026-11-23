import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => ({
  default: { createServer: () => ({ listen: vi.fn() }) },
}));

const { archiveRequestWithLiveGuard, loadFuturesWithArchiveLock, storedSessionSnapshot, healthPayload, strikeFlowFromFiles, truncateStrikeFlow } = await import('./index.mjs');

describe('live-session archive guard', () => {
  it('rejects the current live session before invoking archive payload construction', async () => {
    const buildPayload = vi.fn(async () => ({ status: 202, body: { archived: true } }));
    const at = Date.parse('2026-11-23T13:39:00+05:30');
    const result = await archiveRequestWithLiveGuard('POST', '/api/archive/2026-11-23', {}, at, vi.fn(), buildPayload);
    expect(result).toEqual({ status: 409, body: { error: 'session-live', retryAfter: '16:10 IST' } });
    expect(buildPayload).not.toHaveBeenCalled();
  });

  it('passes past dates through to the existing archive request behavior', async () => {
    const buildPayload = vi.fn(async () => ({ status: 202, body: { archived: '2026-11-20' } }));
    const result = await archiveRequestWithLiveGuard(
      'POST', '/api/archive/2026-11-20', { archive: true },
      Date.parse('2026-11-23T13:39:00+05:30'), 'archive-log', buildPayload,
    );
    expect(result).toEqual({ status: 202, body: { archived: '2026-11-20' } });
    expect(buildPayload).toHaveBeenCalledExactlyOnceWith('POST', '/api/archive/2026-11-20', { archive: true }, 'archive-log');
  });
});

describe('sealed archive futures persistence', () => {
  it('returns a live provider result without waiting for archive completion or writing raw input', async () => {
    let writes = 0;
    const archiveCompletion = new Promise<void>(() => {});
    const resultPromise = loadFuturesWithArchiveLock(
      'sealed',
      async () => ({ symbol: 'ALPHA', session: '2026-11-13', months: [] }),
      async () => { writes += 1; await archiveCompletion; },
    );

    const result = await Promise.race([
      resultPromise,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(result).toEqual({ symbol: 'ALPHA', session: '2026-11-13', months: [] });
    expect(writes).toBe(0);
  });
});

describe('stored session snapshot (post-close fast path)', () => {
  it('serves this session\'s latest.json and rejects a stale session\'s file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-snapshot-'));
    const file = { date: '2026-11-14', t: 1_760_000_000_000, series: [{ s: 'AAA' }] };
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(file));
    expect(storedSessionSnapshot(dir, '2026-11-14')).toMatchObject({ at: file.t, count: 1 });
    // Friday's closing file must never serve Monday's post-close build.
    expect(storedSessionSnapshot(dir, '2026-11-16')).toBeNull();
  });

  it('falls through to the live crawl when the snapshot is missing, corrupt or empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-snapshot-'));
    expect(storedSessionSnapshot(dir, '2026-11-14')).toBeNull();
    writeFileSync(join(dir, 'latest.json'), 'not json at all');
    expect(storedSessionSnapshot(dir, '2026-11-14')).toBeNull();
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({ date: '2026-11-14', t: 1, series: [] }));
    expect(storedSessionSnapshot(dir, '2026-11-14')).toBeNull();
  });
});

describe('strike flow extraction', () => {
  // Schema-1 row contract: strike, side, ltp, prevClose, oi, prevOi, volume, prevVolume, avgPrice, iv, ...
  const minute = (t: number, spot: number, rows: number[][]) => ({
    t, date: '2026-11-13', series: [{ s: 'NIFTY', k: 'index', e: '2026-11-26', t, sp: spot, pc: 24_900, r: rows }],
  });
  const files = [
    minute(1_000, 25_000, [[24_500, 0, 100, 90, 1_000, 900, 50, 40, 100, 17.5], [25_500, 1, 80, 75, 800, 700, 40, 30, 80, 18.5], [30_000, 0, 5, 4, 10, 8, 1, 1, 5, 19.5]]),
    minute(2_000, 25_100, [[24_500, 0, 110, 90, 1_100, 900, 60, 50, 110, 18.5], [25_500, 1, 78, 75, 850, 700, 41, 31, 78, 19.5], [30_000, 0, 4, 4, 10, 8, 1, 1, 4, 20.5]]),
    minute(3_000, 25_200, [[24_500, 0, 125, 90, 1_300, 900, 70, 60, 125, 19.5], [25_500, 1, 76, 75, 900, 700, 42, 32, 76, 20.5]]),
  ];

  it('builds ascending per-strike series with the schema row order (oi before prevOi)', () => {
    const flow = strikeFlowFromFiles(files, ['NIFTY']);
    expect(flow.symbols).toEqual(['NIFTY']);
    expect(flow.date).toBe('2026-11-13');
    expect(flow.expiry.NIFTY).toBe('2026-11-26');
    expect(flow.spot.NIFTY).toEqual([[1_000, 25_000], [2_000, 25_100], [3_000, 25_200]]);
    expect(flow.spotPrevClose.NIFTY).toBe(24_900);
    const ce = flow.strikes['NIFTY|24500|CE'];
    expect(ce.series).toEqual([[1_000, 100, 1_000, 50, 17.5], [2_000, 110, 1_100, 60, 18.5], [3_000, 125, 1_300, 70, 19.5]]);
    expect(ce.prevClose).toBe(90);
    expect(ce.prevOi).toBe(900);
    expect(ce.ltp).toBe(125);
    expect(ce.oi).toBe(1_300);
    expect(ce.iv).toBe(19.5);
    const pe = flow.strikes['NIFTY|25500|PE'];
    expect(pe.side).toBe('PE');
    expect(pe.spotDistancePct).toBeCloseTo(((25_500 - 25_200) / 25_200) * 100, 5);
  });

  it('drops strikes outside the spot window and honours the cap', () => {
    const flow = strikeFlowFromFiles(files, ['NIFTY'], { windowPct: 0.05 });
    expect(Object.keys(flow.strikes).sort()).toEqual(['NIFTY|24500|CE', 'NIFTY|25500|PE']); // 30000 far strike dropped
    const capped = strikeFlowFromFiles(files, ['NIFTY'], { cap: 1 });
    expect(Object.keys(capped.strikes)).toEqual(['NIFTY|25500|PE']); // nearest ATM to spot 25200 kept
  });

  it('truncates every series at the replay cursor — no lookahead', () => {
    const flow = truncateStrikeFlow(strikeFlowFromFiles(files, ['NIFTY']), 2_000);
    expect(flow.spot.NIFTY).toEqual([[1_000, 25_000], [2_000, 25_100]]);
    expect(flow.strikes['NIFTY|24500|CE'].series).toEqual([[1_000, 100, 1_000, 50, 17.5], [2_000, 110, 1_100, 60, 18.5]]);
    expect(flow.strikes['NIFTY|24500|CE'].ltp).toBe(110);
    expect(flow.strikes['NIFTY|24500|CE'].iv).toBe(18.5);
  });

  it('merges two underlyings into one payload with per-symbol spot', () => {
    const bankFiles = files.map(file => ({ ...file, series: [{ s: 'BANKNIFTY', k: 'index', e: '2026-11-26', t: file.t, sp: 51_000, pc: 51_200, r: [[51_000, 1, 200, 190, 2_000, 1_900, 80]] }] }));
    const flow = strikeFlowFromFiles([...files, ...bankFiles], ['NIFTY', 'BANKNIFTY']);
    expect(flow.symbols).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(Object.keys(flow.spot).sort()).toEqual(['BANKNIFTY', 'NIFTY']);
    expect(flow.spot.BANKNIFTY).toEqual([[1_000, 51_000], [2_000, 51_000], [3_000, 51_000]]);
    expect(flow.spotPrevClose.BANKNIFTY).toBe(51_200);
    expect(flow.strikes['BANKNIFTY|51000|PE']).toBeDefined();
    expect(flow.strikes['NIFTY|24500|CE']).toBeDefined();
  });

  it('skips foreign underlyings and malformed rows without dying', () => {
    const noisy = [...files, { t: 4_000, date: '2026-11-13', series: [{ s: 'SONACOMS', k: 'stock', e: '2026-11-26', t: 4_000, sp: 919, r: [[920, 0, 5, 4, 10, 8, 1]] }] },
      minute(5_000, 25_200, [[24_500, 0, 'bad', 90, 1, 1, 1]])];
    const flow = strikeFlowFromFiles(noisy, ['NIFTY']);
    expect(flow.strikes['NIFTY|24500|CE'].series).toHaveLength(3);
    expect(flow.strikes['SONACOMS|920|CE']).toBeUndefined();
  });
});

describe('health payload', () => {
  it('reports provider, feed health, token state and counters without calling the provider chain', () => {
    const provider = {
      id: 'dhan',
      health: () => ({ connections: { open: 4, total: 4 }, healthy: true, flowing: true, packets: 1234, lastPacketAt: 5_000, tokenState: 'rejected' }),
    };
    const state = { lastBuild: { at: 9, series: 215, failed: 0 }, lastError: null };
    const capture = { status: () => ({ done: 1, total: 217, lastPassAt: null, backfill: { done: 0, total: 217, failed: 0 } }) };
    const health = healthPayload(provider, state, capture, 10_000, 0);
    expect(health).toMatchObject({
      provider: 'dhan', uptimeSeconds: 10, tokenState: 'rejected',
      feed: { healthy: true, packets: 1234, lastPacketAt: 5_000, connections: { open: 4, total: 4 } },
      capture: { done: 1, total: 217 },
    });
    expect(health.lastBuild).toEqual({ at: 9, series: 215, failed: 0 });
  });

  it('stays green for a provider without a health surface, and survives a throwing one', () => {
    expect(healthPayload({ id: 'demo' }, { lastBuild: null, lastError: null }, { status: () => ({}) }, 1_000, 0))
      .toMatchObject({ provider: 'demo', uptimeSeconds: 1, tokenState: 'ok', feed: { healthy: true, packets: null } });
    const throwing = { id: 'x', health: () => { throw new Error('boom'); } };
    expect(healthPayload(throwing, { lastBuild: null, lastError: null }, { status: () => ({}) }, 1_000, 0))
      .toMatchObject({ provider: 'x', tokenState: 'ok' });
  });
});
