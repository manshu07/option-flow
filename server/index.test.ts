import { describe, expect, it, vi } from 'vitest';

vi.mock('node:http', () => ({
  default: { createServer: () => ({ listen: vi.fn() }) },
}));

const { loadFuturesWithArchiveLock } = await import('./index.mjs');

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
