import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFullOptionChainSnapshot,
  isFullOptionChainSnapshot,
  normalizeDhanOptionChain,
  persistFullOptionChainSnapshots,
} from './optionChainSnapshots.mjs';

const roots: string[] = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'of-chain-snapshots-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('full option-chain snapshots', () => {
  it('normalizes every strike from an existing Dhan response', () => {
    const at = Date.parse('2026-11-17T09:30:00+05:30');
    const chain = normalizeDhanOptionChain({
      last_price: 100,
      oc: {
        '105': { ce: { last_price: 2, oi: 20, previous_oi: 10, greeks: { delta: 0.25 } } },
        '95': { pe: { last_price: 3, oi: 30, previous_oi: 15 } },
        invalid: { ce: { last_price: 1, oi: 1 } },
      },
    }, { expiry: '2026-11-26', at, prevClose: 99 });

    expect(chain).toMatchObject({ expiry: '2026-11-26', at, spot: 100, prevClose: 99 });
    expect(chain.strikes.map(row => row.strike)).toEqual([95, 105]);
    expect(chain.strikes[0].put).toMatchObject({ ltp: 3, oi: 30, prevOi: 15 });
    expect(chain.strikes[1].call).toMatchObject({ ltp: 2, oi: 20, prevOi: 10, delta: 0.25 });
  });

  it('appends timestamped captures once in the per-symbol session file', () => {
    const root = tempRoot();
    const session = '2026-11-17';
    const chain = normalizeDhanOptionChain({
      last_price: 100,
      oc: { '100': { ce: { last_price: 2, oi: 20 } } },
    }, { expiry: '2026-11-26', at: Date.parse('2026-11-17T09:30:00+05:30') });
    const snapshot = createFullOptionChainSnapshot('NIFTY', session, chain);
    const file = path.join(root, session, 'chains', 'NIFTY.json');
    const later = { ...snapshot, capturedAt: snapshot.capturedAt + 60_000 };

    expect(isFullOptionChainSnapshot(snapshot, 'NIFTY', session)).toBe(true);
    expect(persistFullOptionChainSnapshots(root, [snapshot])).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      symbol: 'NIFTY',
      session,
      snapshots: [{ symbol: 'NIFTY', capturedAt: snapshot.capturedAt }],
    });
    expect(persistFullOptionChainSnapshots(root, [later])).toBe(1);
    expect(persistFullOptionChainSnapshots(root, [snapshot, later])).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).snapshots.map((entry: { capturedAt: number }) => entry.capturedAt)).toEqual([snapshot.capturedAt, later.capturedAt]);
  });

  it('rejects snapshots with mismatched dates or malformed rows', () => {
    const chain = normalizeDhanOptionChain({ last_price: 100, oc: { '100': { ce: { last_price: 2, oi: 20 } } } }, {
      expiry: '2026-11-26',
      at: Date.parse('2026-11-17T09:30:00+05:30'),
    });
    const snapshot = createFullOptionChainSnapshot('NIFTY', '2026-11-17', chain);

    expect(isFullOptionChainSnapshot(snapshot, 'NIFTY', '2026-11-18')).toBe(false);
    expect(isFullOptionChainSnapshot({ ...snapshot, strikes: [{ strike: 100, call: { ltp: null, oi: 20 } }] }, 'NIFTY', '2026-11-17')).toBe(false);
  });
});
