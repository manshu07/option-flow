//
// PERF PROBE (Rust-porting evidence, 2026-11-25): collects the measurements the
// fast-anything candidate list needs — per-route timing histograms, JSON payload
// sizes, and event-loop lag p50/p99 — and appends one JSONL line every 60s to
// server/data/perf-probe.jsonl. Never throws, never blocks a response.
//
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'data', 'perf-probe.jsonl');

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

// route timing: key = "METHOD /api/x" (first path segment), value = {n, sumMs, maxMs, sumBytes}
const routes = new Map();
const buckets = [];
const ROUTE_TOP = 24;

export function perfMark(req, res) {
  req._perfT0 = performance.now();
  const seg = (req.url || '/').split('?')[0].split('/').slice(0, 3).join('/');
  res.on('finish', () => {
    try {
      const ms = performance.now() - (req._perfT0 ?? performance.now());
      const key = `${req.method} ${seg}`;
      let r = routes.get(key);
      if (!r) { r = { n: 0, sumMs: 0, maxMs: 0, sumBytes: 0 }; routes.set(key, r); }
      r.n += 1; r.sumMs += ms; r.maxMs = Math.max(r.maxMs, ms);
      const len = Number(res.getHeader?.('content-length')) || 0;
      r.sumBytes += len;
    } catch { /* probing must never break serving */ }
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] / 1e6; // ns -> ms
}

export function startPerfProbe({ everyMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    try {
      const sorted = Array.from(loop).sort((a, b) => a - b);
      const top = [...routes.entries()]
        .sort((a, b) => b[1].sumMs - a[1].sumMs).slice(0, ROUTE_TOP)
        .map(([route, r]) => ({ route, n: r.n, avgMs: +(r.sumMs / r.n).toFixed(1), maxMs: +r.maxMs.toFixed(1), kbPerReq: +(r.sumBytes / Math.max(r.n, 1) / 1024).toFixed(1) }));
      const line = JSON.stringify({
        at: new Date().toISOString(),
        loop: { p50: +percentile(sorted, 50).toFixed(2), p99: +percentile(sorted, 99).toFixed(2), max: +percentile(sorted, 100).toFixed(2) },
        routes: top,
      });
      fs.appendFileSync(OUT, line + '\n');
      routes.clear();
      loop.reset();
      while (buckets.length) buckets.pop();
    } catch { /* keep the probe silent */ }
  }, everyMs);
  timer.unref?.();
  return timer;
}
