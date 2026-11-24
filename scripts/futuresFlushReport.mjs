import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, process.env.MF_DATA_DIR || 'server/data');
const date = process.argv[2];
const windowArg = process.argv[3] ?? (date === '2026-11-23' ? '08:08-08:12' : '00:00-23:59');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('Usage: node scripts/futuresFlushReport.mjs YYYY-MM-DD [HH:MM-HH:MM]');
  process.exit(2);
}
const dateMs = Date.parse(`${date}T00:00:00Z`);
if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== date) {
  console.error('Date must be a real calendar date in YYYY-MM-DD form.');
  process.exit(2);
}
const windowMatch = windowArg.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
if (!windowMatch) {
  console.error('Window must be HH:MM-HH:MM UTC.');
  process.exit(2);
}
const windowStart = Date.parse(`${date}T${windowMatch[1]}:${windowMatch[2]}:00Z`);
const windowEnd = Date.parse(`${date}T${windowMatch[3]}:${windowMatch[4]}:59.999Z`);
const futuresDir = path.join(DATA_DIR, 'dhan', date, 'futures');
const journalPath = path.join(DATA_DIR, 'dhan', date, 'futures-ticks.ndjson');
const logPath = path.join(DATA_DIR, 'logs', 'order-flow.launchd.out.log');

const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : '—';
const minuteGap = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60_000) : null;

function futuresCandleTimes(value) {
  const months = Array.isArray(value?.months) ? value.months : [];
  const candles = months.flatMap(month => Array.isArray(month?.candles) ? month.candles : []);
  return candles.map(candle => candle?.at).filter(Number.isSafeInteger).sort((a, b) => a - b);
}

const disk = new Map();
let badFutureFiles = 0;
try {
  for (const filename of fs.readdirSync(futuresDir).filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(futuresDir, filename);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const symbol = typeof value?.symbol === 'string' ? value.symbol : filename.slice(0, -5);
      const timestamps = futuresCandleTimes(value);
      disk.set(symbol, {
        candleCount: timestamps.length,
        firstCandleAt: timestamps[0] ?? null,
        lastCandleAt: timestamps.at(-1) ?? null,
        fileMtime: fs.statSync(file).mtimeMs,
        file: path.relative(ROOT, file),
      });
    } catch (error) {
      badFutureFiles++;
      console.error(`skip invalid futures file ${filename}: ${error?.message || error}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.error(`futures directory missing: ${path.relative(ROOT, futuresDir)}`);
}

const journal = new Map();
let journalRows = 0;
let invalidJournalRows = 0;
try {
  const text = fs.readFileSync(journalPath, 'utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { invalidJournalRows++; continue; }
    if (typeof row?.sym !== 'string' || !Number.isSafeInteger(row.at)) { invalidJournalRows++; continue; }
    const values = journal.get(row.sym) ?? [];
    values.push(row.at);
    journal.set(row.sym, values);
    journalRows++;
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.error(`tick journal missing: ${path.relative(ROOT, journalPath)}`);
}

const symbols = [...new Set([...disk.keys(), ...journal.keys()])].sort();
console.log(`Futures flush evidence · session=${date} · log window=${windowArg} UTC`);
console.log('Note: candle `at` values are record times, not physical write timestamps; JSON mtime is the latest write only.');
console.log(`disk files=${disk.size} · tick rows=${journalRows} · malformed tick rows=${invalidJournalRows} · invalid futures files=${badFutureFiles}`);
console.log('symbol | disk candles first..last (UTC) | futures JSON mtime (UTC) | journal rows first..last (UTC) | gaps >5m');

let journalRowsInWindow = 0;
let journalSymbolsInWindow = 0;
let symbolsWithLongGaps = 0;
for (const symbol of symbols) {
  const diskEntry = disk.get(symbol);
  const times = [...new Set(journal.get(symbol) ?? [])].sort((a, b) => a - b);
  const windowRows = (journal.get(symbol) ?? []).filter(at => at >= windowStart && at <= windowEnd).length;
  journalRowsInWindow += windowRows;
  if (windowRows) journalSymbolsInWindow++;
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const minutes = minuteGap(times[i - 1], times[i]);
    if (minutes > 5) gaps.push(`${iso(times[i - 1])}→${iso(times[i])} (${minutes}m)`);
  }
  if (gaps.length) symbolsWithLongGaps++;
  const diskSpan = diskEntry ? `${iso(diskEntry.firstCandleAt)}..${iso(diskEntry.lastCandleAt)} (${diskEntry.candleCount})` : '—';
  const journalSpan = times.length ? `${iso(times[0])}..${iso(times.at(-1))} (${times.length})` : '—';
  console.log(`${symbol} | ${diskSpan} | ${diskEntry ? iso(diskEntry.fileMtime) : '—'} | ${journalSpan} | window rows ${windowRows} | ${gaps.length ? gaps.join('; ') : 'none'}`);
}
console.log(`\nJournal evidence in window: ${journalRowsInWindow} rows across ${journalSymbolsInWindow} symbols; symbols with >5m gaps for the day: ${symbolsWithLongGaps}`);

const archiveFailures = [];
const flushFailures = [];
try {
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)?.[1];
    const timestampMs = timestamp ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(timestampMs) || timestampMs < windowStart || timestampMs > windowEnd) continue;
    if (/archive failed:.*ARCHIVE_FAILED.*Invalid string length/i.test(line)) {
      archiveFailures.push({ line: index + 1, text: line });
    }
    if (/dhan: futures tick flush failed:/i.test(line)) {
      flushFailures.push({ line: index + 1, text: line });
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.error(`launchd log missing: ${path.relative(ROOT, logPath)}`);
}
console.log(`\nArchive Invalid string length failures in ${windowArg} UTC: ${archiveFailures.length}`);
for (const item of archiveFailures) console.log(`${logPath}:${item.line}: ${item.text}`);
console.log(`\nFutures tick flush failures in ${windowArg} UTC: ${flushFailures.length}`);
for (const item of flushFailures) console.log(`${logPath}:${item.line}: ${item.text}`);
