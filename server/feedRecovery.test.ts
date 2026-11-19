import { describe, expect, it } from 'vitest';
import { feedReinitDue, FEED_DOWN_REINIT_MS, FEED_REINIT_COOLDOWN_MS } from './feedRecovery.mjs';

const NOW = 1_000_000_000_000;
const base = { inSession: true, healthy: false, downSince: 0, lastReinitAt: 0, inFlight: false };

describe('feedReinitDue', () => {
  it('never re-inits outside a market session or while the feed is healthy', () => {
    expect(feedReinitDue(NOW, { ...base, inSession: false, downSince: NOW - 200_000 })).toEqual({ due: false, downSince: 0 });
    expect(feedReinitDue(NOW, { ...base, healthy: true, downSince: NOW - 200_000 })).toEqual({ due: false, downSince: 0 });
  });

  it('starts the down clock on the first unhealthy tick but does not fire yet', () => {
    expect(feedReinitDue(NOW, base)).toEqual({ due: false, downSince: NOW });
  });

  it('fires once the feed has been down past the threshold', () => {
    const downSince = NOW - (FEED_DOWN_REINIT_MS + 1_000);
    expect(feedReinitDue(NOW, { ...base, downSince })).toEqual({ due: true, downSince });
  });

  it('does not fire just before the threshold', () => {
    const downSince = NOW - (FEED_DOWN_REINIT_MS - 1_000);
    expect(feedReinitDue(NOW, { ...base, downSince }).due).toBe(false);
  });

  it('respects the cooldown after a recent re-init', () => {
    const downSince = NOW - (FEED_DOWN_REINIT_MS + 1_000);
    const lastReinitAt = NOW - (FEED_REINIT_COOLDOWN_MS - 1_000);
    expect(feedReinitDue(NOW, { ...base, downSince, lastReinitAt }).due).toBe(false);
    // Once the cooldown elapses, it may fire again.
    expect(feedReinitDue(NOW, { ...base, downSince, lastReinitAt: NOW - (FEED_REINIT_COOLDOWN_MS + 1_000) }).due).toBe(true);
  });

  it('does not stack re-inits while one is in flight', () => {
    const downSince = NOW - (FEED_DOWN_REINIT_MS + 1_000);
    expect(feedReinitDue(NOW, { ...base, downSince, inFlight: true }).due).toBe(false);
  });
});