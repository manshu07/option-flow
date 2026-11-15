import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => ({
  default: { createServer: () => ({ listen: vi.fn() }) },
}));

const { loadFuturesWithArchiveLock, storedSessionSnapshot, healthPayload, strikeFlowFromFiles, truncateStrikeFlow } = await import('./index.mjs');

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
  // Schema-1 row contract: strike, side(0=CE,1=PE), ltp, prevClose, oi, prevOi, volume, ...
  const minute = (t: number, spot: number, rows: number[][]) => ({
    t, date: '2026-11-13', series: [{ s: 'NIFTY', k: 'index', e: '2026-11-26', t, sp: spot, pc: 24_900, r: rows }],
  });
  const files = [
    minute(1_000, 25_000, [[24_500, 0, 100, 90, 1_000, 900, 50], [25_500, 1, 80, 75, 800, 700, 40], [30_000, 0, 5, 4, 10, 8, 1]]),
    minute(2_000, 25_100, [[24_500, 0, 110, 90, 1_100, 900, 60], [25_500, 1, 78, 75, 850, 700, 41], [30_000, 0, 4, 4, 10, 8, 1]]),
    minute(3_000, 25_200, [[24_500, 0, 125, 90, 1_300, 900, 70], [25_500, 1, 76, 75, 900, 700, 42]]),
  ];

  it('builds ascending per-strike series with the schema row order (oi before prevOi)', () => {
    const flow = strikeFlowFromFiles(files, ['NIFTY']);
    expect(flow.symbols).toEqual(['NIFTY']);
    expect(flow.date).toBe('2026-11-13');
    expect(flow.expiry.NIFTY).toBe('2026-11-26');
    expect(flow.spot.NIFTY).toEqual([[1_000, 25_000], [2_000, 25_100], [3_000, 25_200]]);
    expect(flow.spotPrevClose.NIFTY).toBe(24_900);
    const ce = flow.strikes['NIFTY|24500|CE'];
    expect(ce.series).toEqual([[1_000, 100, 1_000, 50], [2_000, 110, 1_100, 60], [3_000, 125, 1_300, 70]]);
    expect(ce.prevClose).toBe(90);
    expect(ce.prevOi).toBe(900);
    expect(ce.ltp).toBe(125);
    expect(ce.oi).toBe(1_300);
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
    expect(flow.strikes['NIFTY|24500|CE'].series).toEqual([[1_000, 100, 1_000, 50], [2_000, 110, 1_100, 60]]);
    expect(flow.strikes['NIFTY|24500|CE'].ltp).toBe(110);
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
