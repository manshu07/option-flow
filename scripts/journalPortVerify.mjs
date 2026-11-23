// journalPortVerify — JS vs Rust parity over every stored card with real archive minutes.
// The Rust boundary takes minutes as ONE JSON string (single napi value, no per-node conversion).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, openSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { trackCardFollowThrough: trackRust } = require(path.join(HERE, '..', '.fast', 'lib', 'fa_server_journal_trackcardfollowthrough.node'));
const { trackCardFollowThrough: trackJs } = await import(path.join(HERE, '..', 'server', 'journal.mjs'));

const store = JSON.parse(readFileSync('/tmp/obs-copy.json', 'utf8'));
const cards = store.cards ?? [];
const dates = [...new Set(cards.map(c => c.date).filter(Boolean))].filter(d => existsSync(path.join(HERE, '..', 'server', 'data', 'archives', 'dhan', `${d}.json.gz`)));
const minutesByDate = {}, strByDate = {};
for (const d of dates) {
  const tmp = `/tmp/arc-${d}.json`;
  if (!existsSync(tmp) || readFileSync(tmp, 'utf8').length < 1000) {
    execFileSync('gzip', ['-dc', path.join(HERE, '..', 'server', 'data', 'archives', 'dhan', `${d}.json.gz`)], { stdio: ['ignore', openSync(tmp, 'w'), 'ignore'] });
  }
  const payload = JSON.parse(readFileSync(tmp, 'utf8'));
  const snaps = Object.values(payload.minutes).filter(s => s && s.date === d && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  minutesByDate[d] = snaps;
  strByDate[d] = JSON.stringify(snaps);
  console.log(`${d}: snapshots=${snaps.length} jsonBytes=${strByDate[d].length}`);
}

let pass = 0, fail = 0;
const sorted = v => typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sorted(x)]).sort()) : v;
const deepEq = (a, b) => JSON.stringify(sorted(a ?? null)) === JSON.stringify(sorted(b ?? null));
for (const card of cards) {
  if (!minutesByDate[card.date]) { console.log(`skip ${card.symbol} ${card.date} (no archive)`); continue; }
  const a = trackJs(card, minutesByDate[card.date], {});
  const b = trackRust(card, strByDate[card.date], null, null);
  if (deepEq(a, b)) pass++;
  else {
    fail++;
    console.log(`MISMATCH ${card.symbol} ${card.date} ${card.strike}${card.side}`);
    console.log('  JS  :', JSON.stringify(a)?.slice(0, 400));
    console.log('  RUST:', JSON.stringify(b)?.slice(0, 400));
    if (fail >= 3) break;
  }
}
console.log(`\nidentical: ${pass} · mismatch: ${fail}`);
process.exit(fail ? 1 : 0);
