// scanReplay — fast-anything profile target for (c): boots an ISOLATED instance on 8799
// (own data dir), then hammers the ARCHIVE replay paths of 2026-11-19 — per-minute snapshots
// and per-symbol futures asOf reads — the same resolution code the live board runs in-session.
// Live 8787 is never touched. Exits after the window so the profiler can report.
import { spawn } from 'node:child_process';

const child = spawn('node', ['--max-old-space-size=4096', 'server/index.mjs'], {
  env: { ...process.env, PORT: '8799', MF_DATA_DIR: '/tmp/of-scan-data' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const SYMBOLS = ['TITAN', 'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'LT', 'ITC', 'BHARTIARTL', 'MARUTI', 'TATAMOTORS', 'WIPRO', 'HCLTECH', 'ADANIENT', 'ONGC', 'SUNPHARMA', 'BAJFINANCE'];
const minutesOfDay = [];
for (let m = 9 * 60 + 15; m <= 15 * 60 + 40; m += 5) minutesOfDay.push(`${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`);

const hit = async url => { try { const r = await fetch(url); await r.arrayBuffer(); } catch {} };

async function main() {
  // wait for boot
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:8799/api/health'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  const base = 'http://127.0.0.1:8799';
  const deadline = Date.now() + 240_000;
  let cycle = 0;
  while (Date.now() < deadline) {
    for (const mm of minutesOfDay) {
      if (Date.now() >= deadline) break;
      await hit(`${base}/api/archive/2026-11-19/minute/${mm}`);
      const sym = SYMBOLS[cycle % SYMBOLS.length];
      await hit(`${base}/api/archive/2026-11-19/futures/${sym}?asOf=${mm}`);
      cycle++;
    }
  }
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
  process.exit(0);
}
main();
