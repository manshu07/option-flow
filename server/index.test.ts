import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => ({
  default: { createServer: () => ({ listen: vi.fn() }) },
}));

const { loadFuturesWithArchiveLock, storedSessionSnapshot, healthPayload } = await import('./index.mjs');

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
