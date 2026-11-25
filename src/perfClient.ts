//
// PERF PROBE (client, Rust/WASM-porting evidence): records long tasks (>50ms) and
// page/tab switch durations into window.__perfProbe (ring buffer, last 500 entries).
// Read it from DevTools console: copy(window.__perfProbe.dump()) — nothing is sent
// anywhere, nothing renders, and it can be deleted after the measurement campaign.
//
const entries: Array<Record<string, unknown>> = [];
const MAX = 500;

function push(e: Record<string, unknown>) {
  entries.push(e);
  if (entries.length > MAX) entries.shift();
}

try {
  const obs = new PerformanceObserver((list) => {
    for (const t of list.getEntries()) {
      push({ kind: 'longtask', at: Date.now(), durMs: Math.round(t.duration), name: t.name });
    }
  });
  obs.observe({ entryTypes: ['longtask'] });
} catch { /* longtask unsupported — fine */ }

try {
  let lastVisibleAt = document.visibilityState === 'visible' ? performance.now() : null;
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.visibilityState === 'visible' && lastVisibleAt != null) {
      push({ kind: 'tab-return', at: Date.now(), awayMs: Math.round(now - lastVisibleAt) });
      lastVisibleAt = now;
    } else if (document.visibilityState === 'hidden') {
      lastVisibleAt = now;
    }
  });
} catch { /* ignore */ }

declare global {
  interface Window { __perfProbe?: { dump: () => string } }
}

if (typeof window !== 'undefined') {
  window.__perfProbe = {
    dump: () => JSON.stringify(entries, null, 1),
  };
}

export const perfClientProbeCount = () => entries.length;
