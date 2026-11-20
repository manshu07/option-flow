import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { archivedMinutes } from '../scripts/wallTargetBacktest.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('stream archived wall-target minutes', () => {
  it('parses snapshots incrementally and preserves braces and escaped quotes inside strings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-target-archive-'));
    roots.push(root);
    const file = path.join(root, 'day.json.gz');
    const snapshots = [
      { date: '2026-11-19', t: 1, series: [{ s: 'A', r: [[100, 0, 1]] }], note: 'brace } and quote "' },
      { date: '2026-11-19', t: 2, series: [{ s: 'B', next: { e: '2026-12-31', r: [] } }] },
    ];
    fs.writeFileSync(file, gzipSync(JSON.stringify({ schema: 1, date: '2026-11-19', futures: {}, minutes: { '0915': snapshots[0], '0916': snapshots[1] }, chains: {} })));

    const parsed = [];
    for await (const snapshot of archivedMinutes(file)) parsed.push(snapshot);
    expect(parsed).toEqual(snapshots);
  });

  it('rejects a gzip archive without a minutes object', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-target-archive-'));
    roots.push(root);
    const file = path.join(root, 'day.json.gz');
    fs.writeFileSync(file, gzipSync(JSON.stringify({ date: '2026-11-19', data: [] })));
    await expect(async () => {
      for await (const _ of archivedMinutes(file)) { /* drain */ }
    }).rejects.toThrow('no minutes object');
  });
});
