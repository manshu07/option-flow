import { describe, expect, it } from 'vitest';
import { parseMarketFile } from '../src/features/options-scanner/contractScanModel';
import {
  FUTURES_AFTER_AS_OF,
  FUTURES_BY_AS_OF,
  MANIFEST,
  MARKET_BY_MINUTE,
  REPLAY_DATE,
  fixtureEpoch,
} from '../tests/e2e/fixtures/replay-fixture';

/**
 * API contract coverage for the browser-stubbed layer. This intentionally does
 * not start server/index.mjs: replay routes are supplied by the replay backend,
 * while this test pins the schema-1 payloads consumed by the browser tests.
 */
describe('replay API fixture contract', () => {
  it('describes a partial recorded session and schema-1 market snapshots', () => {
    expect(MANIFEST).toMatchObject({ provider: { id: 'recorded' }, date: REPLAY_DATE });
    expect(MANIFEST.minutes.map(([minute]) => minute)).toContain('1445');
    expect(MANIFEST.minutes.map(([minute]) => minute)).not.toContain('0945');
    expect(MANIFEST.futures.NIFTY.available).toBe(false);
    expect(MARKET_BY_MINUTE['1445']).toMatchObject({ schema: 1, date: REPLAY_DATE });
    expect(parseMarketFile(MARKET_BY_MINUTE['1445'])).not.toBeNull();
  });

  it('keeps replay futures at or before the requested as-of timestamp', () => {
    const asOf = fixtureEpoch('1447');
    const candles = FUTURES_BY_AS_OF['1447'].months.flatMap(month => month.candles);
    expect(candles.every(candle => candle.at + 60_000 <= asOf)).toBe(true);
    expect(FUTURES_AFTER_AS_OF.months[0].candles.some(candle => candle.at === asOf)).toBe(true);
    expect(FUTURES_AFTER_AS_OF.months[0].candles.at(-1)?.at).toBeGreaterThan(fixtureEpoch('1447'));
  });
});
