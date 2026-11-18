/**
 * Gamma flip validation report — runs over already-captured days, offline.
 *
 *   node scripts/gammaValidationReport.mjs 2026-11-17 2026-11-18 [SYMBOLS]
 *
 * SYMBOLS defaults to GAMMA_SYMBOLS (env) or NIFTY,BANKNIFTY,RELIANCE,HDFCBANK,
 * TCS,ITC,SBIN. For each day it samples the captured market minutes every
 * `STEP` minutes (default 5), computes the gamma profile for each symbol (pure
 * model, no network), records where spot crosses the flip level, and joins the
 * move afterwards from the persisted futures minutes.
 *
 * Writes server/data/gamma-validation.json and prints a plain-English summary.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gammaProfile, gammaRiskFreeRate } from '../src/features/market-flow/gammaModel.ts';
import { readFutures } from '../server/replayStorage.mjs';
import { evaluateCrosses, summarize, summaryLines } from '../server/gammaValidation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'server', 'data', 'dhan');
const STEP = Math.max(1, Number(process.env.GAMMA_VALIDATION_STEP) || 5);
const OUT = path.join(ROOT, 'server', 'data', 'gamma-validation.json');

const args = process.argv.slice(2);
const from = args[0] ?? null;
const to = args[1] ?? from;
const symbols = (args[2] ?? process.env.GAMMA_SYMBOLS ?? 'NIFTY,BANKNIFTY,RELIANCE,HDFCBANK,TCS,ITC,SBIN')
  .split(',').map(item => item.trim()).filter(Boolean);

if (!from) {
  console.error('usage: node scripts/gammaValidationReport.mjs <from-date> [to-date] [SYMBOLS]');
  process.exit(1);
}

const dates = () => {
  if (!existsSync(DATA)) return [];
  return readdirSync(DATA)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name >= from && name <= to)
    .sort();
};

const r = gammaRiskFreeRate(process.env.GAMMA_RISK_FREE);
const records = [];
const perDay = [];
const skipped = { days: 0, symbolsMissing: new Set() };

for (const date of dates()) {
  const dir = path.join(DATA, date);
  let minutes = [];
  try { minutes = readdirSync(dir).filter(name => /^\d{4}\.json$/.test(name)).sort(); } catch { skipped.days++; continue; }
  if (!minutes.length) { skipped.days++; continue; }
  const picked = minutes.filter((_, index) => index % STEP === 0);
  const samples = new Map(symbols.map(symbol => [symbol, []]));
  for (const minuteFile of picked) {
    let snapshot;
    try { snapshot = JSON.parse(readFileSync(path.join(dir, minuteFile), 'utf8')); } catch { continue; }
    const at = Number(snapshot?.t);
    if (!Number.isFinite(at)) continue;
    const seriesBySymbol = new Map((snapshot.series ?? []).map(item => [item.s, item]));
    for (const symbol of symbols) {
      const series = seriesBySymbol.get(symbol);
      if (!series || !Number.isFinite(series.sp)) { skipped.symbolsMissing.add(symbol); continue; }
      const profile = gammaProfile(series, { lot: series.lot ?? 1, r });
      if (!profile || !Number.isFinite(profile.flipLevel)) continue;
      samples.get(symbol).push({ at, spot: series.sp, flip: profile.flipLevel, regime: profile.regime ?? null });
    }
  }
  let dayRecords = 0;
  for (const symbol of symbols) {
    const list = samples.get(symbol);
    if (!list.length) continue;
    let points = [];
    try {
      const stored = readFutures(DATA, date, symbol);
      points = (stored?.months?.[0]?.candles ?? []).map(candle => ({ at: candle.at, close: candle.close }));
    } catch { points = []; }
    const found = evaluateCrosses({ symbol, samples: list, points });
    if (!found.length) continue;
    dayRecords += found.length;
    records.push(...found.map(record => ({ date, ...record })));
  }
  perDay.push({ date, minutes: minutes.length, sampled: picked.length, crosses: dayRecords });
  console.log(`${date}: ${picked.length} sampled minutes, ${dayRecords} flip cross(es)`);
}

const summary = summarize(records);
const report = {
  generatedAt: new Date().toISOString(),
  from,
  to,
  symbols,
  stepMinutes: STEP,
  perDay,
  summary,
  records: records.map(record => ({
    date: record.date,
    symbol: record.symbol,
    at: record.at,
    direction: record.direction,
    spot: Number(record.spot.toFixed(2)),
    flip: Number(record.flip.toFixed(2)),
    returns: record.returns,
    matchPct: record.matchPct,
    followed: record.followed,
  })),
};
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('');
for (const line of summaryLines(summary, { from, to, symbols: symbols.join(',') })) console.log(line);
if (skipped.days) console.log(`(${skipped.days} day(s) had no captured minutes — skipped)`);
const never = symbols.filter(symbol => skipped.symbolsMissing.has(symbol) && !records.some(record => record.symbol === symbol));
if (never.length) console.log(`No captured chain for: ${never.join(', ')}`);
console.log(`\nreport → ${path.relative(ROOT, OUT)}`);