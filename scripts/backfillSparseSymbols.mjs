// backfillSparseSymbols — one-off retry: backfill TODAY's futures candles for symbols whose
// charts REST failed during the day (429 storms). Uses provider.backfillTodayFutures with an
// explicit session + force + postClose, so it works outside market hours.
//   node scripts/backfillSparseSymbols.mjs 2026-11-23 SYM1,SYM2,...
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createDhanProvider } from '../server/providers/dhan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , session = '2026-11-23', list] = process.argv;
if (!list) { console.error('usage: node scripts/backfillSparseSymbols.mjs <YYYY-MM-DD> SYM1,SYM2,...'); process.exit(1); }
const symbols = list.split(',').map(s => s.trim()).filter(Boolean);

// .env is loaded by server/index.mjs normally; here we parse it manually.
for (const line of fs.readFileSync(path.join(HERE,'..','.env'),'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const universe = JSON.parse(fs.readFileSync(path.join(HERE,'..','public','underlyings.json'),'utf8')).underlyings
  .filter(u => u && typeof u.symbol === 'string' && u.lot > 0);
const provider = createDhanProvider(universe);
await provider.init();
await provider.init?.();

const result = await provider.backfillTodayFutures(session, { symbols, force: true, postClose: true });
console.log('attempted:', result.attempted ?? symbols.length);
for (const u of result.updates ?? []) console.log('  updated:', u.symbol ?? u);
for (const f of result.failed ?? []) console.log('  FAILED:', f.symbol ?? f, f.error ?? '');
console.log(`done: ${result.updates?.length ?? 0} updated, ${result.failed?.length ?? 0} failed`);
process.exit(0);
