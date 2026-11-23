// journalPortVerify — JS vs Rust parity over every stored card with real archive minutes.
// The Rust boundary takes minutes as ONE JSON string (single napi value, no per-node conversion).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, openSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { trackCardFollowThrough: trackRust } = require(path.join(HERE, '..', '.fast', 'lib', 'fa_server_journal_trackcardfollowthrough.node'));
const journal = await import(path.join(HERE, '..', 'server', 'journal.mjs'));
const trackJs = journal.trackCardFollowThroughJs ?? journal.trackCardFollowThrough;
const trackWrapped = journal.trackCardFollowThrough;
if (process.env.FAST_ANYTHING_DISABLE === '1' || !journal.journalRustEnabled) {
  throw new Error('Rust journal wrapper is disabled or the native addon failed to load.');
}

const store = JSON.parse(readFileSync('/tmp/obs-copy.json', 'utf8'));
const cards = store.cards ?? [];
const dates = [...new Set(cards.map(c => c.date).filter(Boolean))].filter(d => existsSync(path.join(HERE, '..', 'server', 'data', 'archives', 'dhan', `${d}.json.gz`)));
const minutesByDate = {};
for (const d of dates) {
  const tmp = `/tmp/arc-${d}.json`;
  if (!existsSync(tmp) || readFileSync(tmp, 'utf8').length < 1000) {
    execFileSync('gzip', ['-dc', path.join(HERE, '..', 'server', 'data', 'archives', 'dhan', `${d}.json.gz`)], { stdio: ['ignore', openSync(tmp, 'w'), 'ignore'] });
  }
  const payload = JSON.parse(readFileSync(tmp, 'utf8'));
  const snaps = Object.values(payload.minutes).filter(s => s && s.date === d && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  minutesByDate[d] = snaps;
  console.log(`${d}: snapshots=${snaps.length}`);
}

let pass = 0, fail = 0;
let wrapperReplayCount = 0;
const sorted = v => typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sorted(x)]).sort()) : v;
const deepEq = (a, b) => JSON.stringify(sorted(a ?? null)) === JSON.stringify(sorted(b ?? null));

const fixtureDate = '2026-11-16';
const fixtureClose = Date.parse(`${fixtureDate}T10:10:00Z`);
const fixtureFrom = fixtureClose - 3 * 60_000;
const fixtureExpiry = '2026-11-23';
const fixtureCard = overrides => ({
  id: `TMPV|${fixtureDate}`, at: fixtureFrom, date: fixtureDate, symbol: 'TMPV', bias: 'bullish', side: 'CE', strike: 265,
  expiry: fixtureExpiry, entry: 100, sl: 55, tgt1: 155, tgt2: 190, ...overrides,
});
const optionRow = (strike, side, premium, high = premium, low = premium) => [strike, side, premium, premium, 1_000, 900, 1, 0, 0, null, 0, 0, 0, 0, high, low, null, null];
const reading = (at, premium, high = premium, low = premium, overrides = {}, side = 0) => ({
  date: fixtureDate, t: at,
  series: [{ s: 'TMPV', e: fixtureExpiry, t: at, r: [optionRow(265, side, premium, high, low)], ...overrides }],
});
const firstFull = Date.parse(`${fixtureDate}T09:46:00+05:30`);
const archiveClose = fixtureClose + 3_000;
const absentExtremes = reading(fixtureFrom, 100);
absentExtremes.series[0].r[0][14] = null;
absentExtremes.series[0].r[0][15] = null;
const overlapping = reading(fixtureFrom + 60_000, 50, 100, 50);
overlapping.series[0].r[0][14] = null;
const fixtureCases = [
  ['post-target-then-stop', fixtureCard(), [reading(fixtureFrom, 100), reading(fixtureFrom + 60_000, 160), reading(fixtureFrom + 120_000, 195), reading(fixtureFrom + 180_000, 50)], {}],
  ['post-stop-then-targets-bearish', fixtureCard({ bias: 'bearish', side: 'PE' }), [100, 50, 160, 195].map((p, i) => reading(fixtureFrom + i * 60_000, p, p, p, {}, 1)), {}],
  ['pre-call-cumulative-extremes', fixtureCard(), [reading(fixtureFrom - 60_000, 100, 250, 20), reading(fixtureFrom, 100, 250, 20), reading(fixtureFrom + 60_000, 110, 250, 20), reading(fixtureFrom + 120_000, 90, 250, 20), reading(fixtureFrom + 180_000, 105, 250, 20)], {}],
  ['new-cumulative-extremes-ambiguous', fixtureCard(), [reading(fixtureFrom, 100, 110, 90), reading(fixtureFrom + 60_000, 120, 200, 50)], {}],
  ['unbounded-first-extreme-and-pre-call-gap', fixtureCard(), [reading(fixtureFrom - 120_000, 100, 110, 90), reading(fixtureFrom + 60_000, 100, 250, 20), reading(fixtureFrom + 120_000, 110, 250, 20)], {}],
  ['absent-high-low-fields', fixtureCard(), [absentExtremes, reading(fixtureFrom + 60_000, 110, 250, 20)], {}],
  ['wrong-expiry-stale-series-and-missing-row', fixtureCard(), [
    reading(fixtureFrom, 300, 300, 20, { e: '2026-11-30' }),
    reading(fixtureFrom + 60_000, 300, 300, 20, { t: fixtureFrom - 1 }),
    reading(fixtureFrom + 120_000, 300, 300, 20, { r: [optionRow(270, 0, 300), optionRow(265, 1, 300)] }),
  ], {}],
  ['archive-gaps-closing-date-and-post-close', fixtureCard(), [
    reading(fixtureFrom, 100), reading(fixtureFrom, 100), reading(fixtureFrom + 120_000, 120), reading(archiveClose, 130),
    reading(fixtureClose + 60_000, 300), { ...reading(fixtureFrom + 60_000, 300), date: '2026-11-17' },
  ], { source: 'archive' }],
  ['overlapping-evidence-intervals', fixtureCard(), [reading(fixtureFrom, 100, 100, 100), overlapping, reading(fixtureFrom + 120_000, 120, 200, 50)], {}],
  ['futures-first-full-minute-and-session-close', fixtureCard({ at: Date.parse(`${fixtureDate}T09:45:23+05:30`) }), [], { futuresCandles: [
    { at: firstFull + 120_000, high: 115, low: 95 }, { at: firstFull - 60_000, high: 10_000, low: 1 },
    { at: firstFull, high: 110, low: 100 }, { at: fixtureClose, high: 20_000, low: 0.1 },
    { at: firstFull + 86_400_000, high: 30_000, low: 0.01 },
  ] }],
  ['futures-entry-boundary', fixtureCard({ at: Date.parse(`${fixtureDate}T09:45:00+05:30`) }), [], { futuresCandles: [
    { at: Date.parse(`${fixtureDate}T09:45:00+05:30`), high: 120, low: 100 },
    { at: fixtureClose - 60_000, high: 130, low: 90 },
  ] }],
  ['empty-minutes-without-futures', fixtureCard(), [], {}],
  ['legacy-missing-evidence-empty-minutes', fixtureCard({ date: '2026-11-24', at: Date.parse('2026-11-24T10:09:00Z') }), [], {}],
  ['futures-invalid-fields-and-empty-minutes', fixtureCard(), [], { futuresCandles: [
    { at: fixtureFrom, close: 100 }, { at: fixtureFrom + 60_000, high: null, low: 50 },
    { at: fixtureFrom + 120_000, high: 50, low: 100 }, { at: fixtureFrom + 30_000, high: 500, low: 1 },
  ] }],
];

const firstDifference = (a, b, field = '$') => {
  if (deepEq(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return field;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return `${field}.${key}`;
    const diff = firstDifference(a[key], b[key], Array.isArray(a) ? `${field}[${key}]` : `${field}.${key}`);
    if (diff) return diff;
  }
  return field;
};
let fixturePass = 0, fixtureFail = 0;
console.log('\nFixture parity: fixture | JS result | Rust result | first differing field');
for (const [name, card, minutes, options] of fixtureCases) {
  const js = trackJs(card, minutes, options);
  const futuresJson = options.futuresCandles == null ? null : JSON.stringify(options.futuresCandles);
  const rust = trackRust(card, JSON.stringify(minutes), options.source ?? null, futuresJson);
  const difference = firstDifference(js, rust);
  if (difference) fixtureFail++; else fixturePass++;
  console.log(`${name} | ${JSON.stringify(js)} | ${JSON.stringify(rust)} | ${difference ?? '—'}`);
  if (typeof trackWrapped === 'function' && !deepEq(trackWrapped(card, minutes, options), js)) {
    fixtureFail++;
    console.log(`${name} | wrapper differs from JS reference | ${JSON.stringify(trackWrapped(card, minutes, options))} | wrapper`);
  }
}
console.log(`fixture parity: ${fixturePass}/${fixtureCases.length} · mismatch: ${fixtureFail}`);

for (const card of cards) {
  if (!minutesByDate[card.date]) { console.log(`skip ${card.symbol} ${card.date} (no archive)`); continue; }
  const a = trackJs(card, minutesByDate[card.date], {});
  const wrapped = trackWrapped(card, minutesByDate[card.date], {});
  wrapperReplayCount++;
  if (deepEq(a, wrapped)) pass++;
  else {
    fail++;
    console.log(`MISMATCH ${card.symbol} ${card.date} ${card.strike}${card.side}`);
    console.log('  JS  :', JSON.stringify(a)?.slice(0, 400));
    console.log('  WRAP:', JSON.stringify(wrapped)?.slice(0, 400));
    if (fail >= 3) break;
  }
}
if (!wrapperReplayCount) throw new Error('No real-archive card was available to exercise the Rust wrapper.');
console.log(`\nidentical: ${pass} · mismatch: ${fail} · Rust wrapper cards: ${wrapperReplayCount}`);
process.exit(fail || fixtureFail ? 1 : 0);
