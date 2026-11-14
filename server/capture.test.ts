import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredIntervalMs, createCapture } from './capture.mjs';
import { persistFutures, readFutures } from './replayStorage.mjs';

const SESSION = '2026-11-13';
const AT = Date.parse(`${SESSION}T10:00:00+05:30`);
const universe = ['ALPHA', 'BETA', 'GAMMA', 'DELTA'].map(symbol => ({ symbol }));
const tempDirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'of-capture-'));
  tempDirs.push(dir);
  return dir;
}

function fixture(symbol: string) {
  return {
    symbol,
    session: SESSION,
    months: [{
      date: '2026-12-31',
      prevClose: 100,
      prevOi: 10,
      candles: [{ at: AT, close: 101, oi: 11 }],
    }],
  };
}

function timers() {
  const entries: { callback: () => void; delay: number }[] = [];
  return {
    entries,
    setInterval: (callback: () => void, delay: number) => {
      entries.push({ callback, delay });
      return entries.length;
    },
    clearInterval: (id: number) => { entries[id - 1] = undefined as never; },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('server futures capture', () => {
  it('uses a 60 second default and honors MF_CAPTURE_SEC', async () => {
    const previous = process.env.MF_CAPTURE_SEC;
    try {
      delete process.env.MF_CAPTURE_SEC;
      expect(configuredIntervalMs()).toBe(60_000);
      const defaultClock = timers();
      const defaultCapture = createCapture({
        provider: { alwaysLive: false }, universe: [], now: () => AT, isMarketSessionTime: () => false,
        futuresFor: async () => [], setInterval: defaultClock.setInterval, clearInterval: defaultClock.clearInterval,
      });
      defaultCapture.start();
      expect(defaultClock.entries[0].delay).toBe(60_000);
      await defaultCapture.stop();

      process.env.MF_CAPTURE_SEC = '45';
      expect(configuredIntervalMs()).toBe(45_000);
      const configuredClock = timers();
      const configuredCapture = createCapture({
        provider: { alwaysLive: false }, universe: [], now: () => AT, isMarketSessionTime: () => false,
        futuresFor: async () => [], setInterval: configuredClock.setInterval, clearInterval: configuredClock.clearInterval,
      });
      configuredCapture.start();
      expect(configuredClock.entries[0].delay).toBe(45_000);
      await configuredCapture.stop();

      process.env.MF_CAPTURE_SEC = '0';
      expect(configuredIntervalMs()).toBe(60_000);
    } finally {
      if (previous == null) delete process.env.MF_CAPTURE_SEC;
      else process.env.MF_CAPTURE_SEC = previous;
    }
  });

  it('writes one persisted futures file per symbol in a successful pass', async () => {
    const scanDir = tempDir();
    const capture = createCapture({
      provider: { alwaysLive: false },
      universe,
      now: () => AT,
      isMarketSessionTime: () => true,
      sessionFor: () => SESSION,
      futuresFor: async (symbol, session) => persistFutures(scanDir, session, symbol, fixture(symbol)),
      logger: () => {},
    });

    await capture.runNow();

    for (const { symbol } of universe) expect(readFutures(scanDir, SESSION, symbol)).toMatchObject({ symbol, session: SESSION });
    expect(capture.status()).toEqual({ done: universe.length, total: universe.length, lastPassAt: AT });
  });

  it('logs a failed symbol, completes the pass, and retries it on the next rotation', async () => {
    const scanDir = tempDir();
    const calls: string[] = [];
    let failed = true;
    const errors: unknown[][] = [];
    const capture = createCapture({
      provider: { alwaysLive: false },
      universe,
      now: () => AT,
      isMarketSessionTime: () => true,
      sessionFor: () => SESSION,
      futuresFor: async (symbol, session) => {
        calls.push(symbol);
        if (symbol === 'ALPHA' && failed) {
          failed = false;
          throw new Error('fixture failure');
        }
        return persistFutures(scanDir, session, symbol, fixture(symbol));
      },
      logger: (...args: unknown[]) => errors.push(args),
    });

    await capture.runNow();
    expect(capture.status().done).toBe(3);
    expect(errors).toHaveLength(1);
    await capture.runNow();

    expect(calls.slice(0, 4)).toEqual(['ALPHA', 'BETA', 'GAMMA', 'DELTA']);
    expect(calls.slice(4)).toContain('ALPHA');
    expect(capture.status().done).toBe(4);
    expect(readFutures(scanDir, SESSION, 'ALPHA')).not.toBeNull();
  });

  it('does no work outside a session or for an always-live provider', async () => {
    let calls = 0;
    const options = {
      universe,
      now: () => AT,
      isMarketSessionTime: () => false,
      sessionFor: () => SESSION,
      futuresFor: async () => { calls += 1; },
      logger: () => {},
    };
    await createCapture({ ...options, provider: { alwaysLive: false } }).runNow();
    await createCapture({ ...options, provider: { alwaysLive: true } }).runNow();
    await createCapture({ ...options, provider: { id: 'demo', alwaysLive: false } }).runNow();
    expect(calls).toBe(0);

    const clock = timers();
    const alwaysLive = createCapture({ ...options, provider: { alwaysLive: true }, setInterval: clock.setInterval, clearInterval: clock.clearInterval });
    alwaysLive.start();
    expect(clock.entries).toHaveLength(0);
    expect(alwaysLive.status()).toEqual({ done: 0, total: universe.length, lastPassAt: null });

    const demoClock = timers();
    const demo = createCapture({ ...options, provider: { id: 'demo', alwaysLive: false }, setInterval: demoClock.setInterval, clearInterval: demoClock.clearInterval });
    demo.start();
    expect(demoClock.entries).toHaveLength(0);
  });

  it('limits concurrency, skips an overlapping pass, and stop clears its timer', async () => {
    const clock = timers();
    let active = 0;
    let peak = 0;
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const capture = createCapture({
      provider: { alwaysLive: false },
      universe,
      now: () => AT,
      isMarketSessionTime: () => true,
      sessionFor: () => SESSION,
      futuresFor: async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await pending;
        active -= 1;
      },
      logger: () => {},
      intervalMs: 1_234,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    expect(capture.start()).toBeUndefined();
    expect(clock.entries[0].delay).toBe(1_234);
    const overlap = capture.runNow();
    expect(active).toBe(3);
    expect(calls).toBe(3);
    release();
    await overlap;
    await capture.stop();
    expect(peak).toBe(3);
    expect(clock.entries[0]).toBeUndefined();
  });

  it('stops starting symbols when the session ends and keeps completed futures', async () => {
    const scanDir = tempDir();
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let inSession = true;
    const capture = createCapture({
      provider: { id: 'dhan', alwaysLive: false },
      universe,
      now: () => AT,
      isMarketSessionTime: () => inSession,
      sessionFor: () => SESSION,
      futuresFor: async (symbol, session) => {
        started.push(symbol);
        await new Promise<void>(resolve => releases.push(resolve));
        return persistFutures(scanDir, session, symbol, fixture(symbol));
      },
      logger: () => {},
    });

    const pass = capture.runNow();
    expect(started).toHaveLength(3);
    inSession = false;
    for (const release of releases) release();
    await pass;

    expect(started).toEqual(['ALPHA', 'BETA', 'GAMMA']);
    expect(capture.status()).toEqual({ done: 3, total: universe.length, lastPassAt: AT });
    for (const symbol of started) expect(readFutures(scanDir, SESSION, symbol)).not.toBeNull();
    expect(readFutures(scanDir, SESSION, 'DELTA')).toBeNull();
  });
});
