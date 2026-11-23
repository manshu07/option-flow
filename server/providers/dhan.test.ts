import { describe, expect, it, vi } from 'vitest';
import { createFuturesFlushWatchdog } from './dhan.mjs';

function fakeTimers() {
  const intervals: Array<{ callback: () => unknown; ms: number; unref: ReturnType<typeof vi.fn>; cleared?: boolean }> = [];
  return {
    intervals,
    setInterval: vi.fn((callback: () => unknown, ms: number) => {
      const timer = { callback, ms, unref: vi.fn() };
      intervals.push(timer);
      return timer;
    }),
    clearInterval: vi.fn((timer: { cleared?: boolean }) => { timer.cleared = true; }),
  };
}

describe('Dhan futures flush watchdog', () => {
  it('swallows a one-off journal append failure and succeeds on the next flush', () => {
    const timers = fakeTimers();
    const logger = vi.fn();
    let now = 1_000;
    const append = vi.fn().mockReturnValue(1).mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => { throw new Error('disk busy'); }).mockReturnValue(1);
    const flush = createFuturesFlushWatchdog({
      flush: append,
      now: () => now,
      logger,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    flush.start();
    expect(append).toHaveBeenCalledTimes(1);
    expect(flush.lastFlushAt).toBe(1_000);
    expect(timers.intervals[0].ms).toBe(60_000);

    now += 60_000;
    expect(flush.flushNow()).toBe(false);
    expect(flush.lastFlushAt).toBe(1_000);
    expect(logger).toHaveBeenCalledTimes(1);

    now += 60_000;
    expect(flush.flushNow()).toBe(true);
    expect(append).toHaveBeenCalledTimes(3);
    expect(flush.lastFlushAt).toBe(now);
    expect(logger).toHaveBeenCalledTimes(1);
    flush.stop();
  });

  it('recreates a stalled interval at the five-minute watchdog check while the market and feed are live', () => {
    const timers = fakeTimers();
    const logger = vi.fn();
    const write = vi.fn(() => true);
    let now = 0;
    const flush = createFuturesFlushWatchdog({
      flush: write,
      now: () => now,
      isMarketSessionTime: () => true,
      feedFlowing: () => true,
      logger,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    flush.start();
    const original = timers.intervals[0];
    const watchdog = timers.intervals[1];
    expect(original.ms).toBe(60_000);
    expect(watchdog.ms).toBe(5 * 60_000);

    now = 5 * 60_000 + 1_000;
    watchdog.callback();

    expect(timers.clearInterval).toHaveBeenCalledExactlyOnceWith(original);
    expect(original.cleared).toBe(true);
    expect(timers.intervals.at(-1).ms).toBe(60_000);
    expect(write).toHaveBeenCalledTimes(2); // boot flush, then immediate recovery flush
    expect(flush.lastFlushAt).toBe(now);
    expect(logger).toHaveBeenCalledWith('futures flush watchdog: restarted after 301s stall');
    flush.stop();
  });

  it('does not restart outside market hours or while the feed is not flowing', () => {
    const timers = fakeTimers();
    const flush = createFuturesFlushWatchdog({
      flush: () => true,
      now: () => 5 * 60_000,
      isMarketSessionTime: () => false,
      feedFlowing: () => false,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    flush.start();
    timers.intervals[1].callback();
    expect(timers.clearInterval).not.toHaveBeenCalled();
    expect(timers.intervals).toHaveLength(2);
    flush.stop();
  });
});
