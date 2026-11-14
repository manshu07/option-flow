import { getLatestTradingSessionDate, isMarketSessionTime as marketSessionTime } from '../src/lib/marketSession.ts';

const MAX_CONCURRENT = 3;
const DEFAULT_INTERVAL_MS = 60_000;

function configuredIntervalMs(value = process.env.MF_CAPTURE_SEC) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_INTERVAL_MS;
}

function report(logger, ...args) {
  if (typeof logger === 'function') logger(...args);
  else if (logger?.error) logger.error(...args);
}

export function captureRequest(method, requestUrl, capture, logger = console) {
  if (method !== 'POST' || !/^\/api\/capture\/now(?:\?|$)/.test(requestUrl ?? '')) return null;
  try {
    Promise.resolve(capture.runNow()).catch(error => report(logger, 'capture trigger failed:', error?.message || error));
  } catch (error) {
    report(logger, 'capture trigger failed:', error?.message || error);
  }
  return { status: 202, body: { capture: capture.status() } };
}

export function withCaptureStatus(status, capture) {
  return { ...status, capture: capture.status() };
}

/**
 * Capture futures for the mapped universe without coupling the loop to HTTP.
 * The injected clock and timers make the scheduling deterministic in tests.
 */
export function createCapture({
  provider,
  universe = [],
  futuresFor,
  now = () => Date.now(),
  isMarketSessionTime = marketSessionTime,
  sessionFor = at => getLatestTradingSessionDate(new Date(at)),
  logger = console,
  intervalMs = configuredIntervalMs(),
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
} = {}) {
  const symbols = universe.map(underlying => typeof underlying === 'string' ? underlying : underlying?.symbol).filter(Boolean);
  const state = { done: 0, total: symbols.length, lastPassAt: null };
  let timer = null;
  let inFlight = null;
  let startIndex = 0;

  const eligible = () => provider?.id !== 'demo' && !provider?.alwaysLive && isMarketSessionTime(now());

  async function pass() {
    if (!eligible() || inFlight) return;

    const order = symbols.length
      ? symbols.map((_, offset) => symbols[(startIndex + offset) % symbols.length])
      : [];
    if (symbols.length) startIndex = (startIndex + 1) % symbols.length;

    const work = (async () => {
      let cursor = 0;
      let done = 0;
      const session = sessionFor(now());
      const worker = async () => {
        while (cursor < order.length && eligible()) {
          const symbol = order[cursor++];
          try {
            await futuresFor(symbol, session);
            done += 1;
          } catch (error) {
            report(logger, `capture futures ${symbol} failed:`, error?.message || error);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, order.length) }, worker));
      state.done = done;
      state.total = symbols.length;
      state.lastPassAt = now();
    })();

    inFlight = work;
    try {
      await work;
    } catch (error) {
      report(logger, 'capture pass failed:', error?.message || error);
    } finally {
      if (inFlight === work) inFlight = null;
    }
  }

  const tick = () => {
    void pass().catch(error => report(logger, 'capture tick failed:', error?.message || error));
  };

  return {
    start() {
      if (timer !== null || provider?.alwaysLive || provider?.id === 'demo') return;
      timer = setIntervalFn(tick, intervalMs);
      tick();
    },
    runNow: pass,
    status() {
      return { ...state };
    },
    async stop() {
      if (timer !== null) {
        clearIntervalFn(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
    },
  };
}

export { configuredIntervalMs };
