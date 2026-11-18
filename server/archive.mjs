import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gzip, gzipSync, gunzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { isMarketSessionTime, marketSessionBounds } from '../src/lib/marketSession.ts';
import { isFullOptionChainSnapshot, isFullOptionChainSnapshotCollection } from './optionChainSnapshots.mjs';

export const ARCHIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = /^\d{4}$/;
const SYMBOL = /^[A-Z0-9&._-]{1,40}$/;
const PROVIDER = /^[A-Za-z0-9._-]{1,40}$/;
const INDEX_FILE = 'index.json';
const DEFAULT_KEEP = 30;
const ARCHIVE_DAY_CACHE = { 'Cache-Control': 'public, max-age=86400' };
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class ArchiveError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new ArchiveError(code, message, details); };

function validDate(date) {
  if (typeof date !== 'string' || !ARCHIVE_DATE.test(date)) return false;
  const at = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
}

function requireDate(date) {
  if (!validDate(date)) fail('ARCHIVE_DATE_INVALID', 'Invalid archive session date.');
}

function providerRoot(archiveRoot, providerId) {
  if (typeof providerId !== 'string' || !PROVIDER.test(providerId)) fail('ARCHIVE_PROVIDER_INVALID', 'Invalid archive provider.');
  return path.join(archiveRoot, providerId);
}

function archivePath(archiveRoot, providerId, date) {
  requireDate(date);
  return path.join(providerRoot(archiveRoot, providerId), `${date}.json.gz`);
}

function readJson(file, code, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('ARCHIVE_MISSING', `${label} is missing.`);
    fail(code, `Unable to read ${label}.`);
  }
  try { return JSON.parse(text); }
  catch { fail(code, `${label} is not valid JSON.`); }
}

function readChainSnapshots(day, date, sourceFiles) {
  const dir = path.join(day, 'chains');
  if (!fs.existsSync(dir)) return {};
  if (!fs.statSync(dir).isDirectory()) fail('ARCHIVE_CHAIN_INVALID', `Chain storage for ${date} is not a directory.`);
  const chains = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.json')) continue;
    const symbol = entry.name.slice(0, -5);
    if (!SYMBOL.test(symbol) || !entry.isFile()) fail('ARCHIVE_CHAIN_INVALID', `Invalid chain file ${entry.name}.`);
    const file = path.join(dir, entry.name);
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch { fail('ARCHIVE_MISSING', `Chain snapshot ${symbol} is missing for ${date}.`); }
    let snapshot;
    try { snapshot = JSON.parse(bytes.toString('utf8')); }
    catch { fail('ARCHIVE_JSON_INVALID', `Chain snapshot ${symbol} is not valid JSON.`); }
    if (!isFullOptionChainSnapshotCollection(snapshot, symbol, date)) fail('ARCHIVE_CHAIN_INVALID', `Chain snapshot ${symbol} is invalid for ${date}.`);
    chains[symbol] = snapshot.snapshots;
    sourceFiles.push({ name: `chains/${entry.name}`, bytes });
  }
  return chains;
}

function sourceIndex(scanDir, date) {
  const file = path.join(scanDir, date, INDEX_FILE);
  const value = readJson(file, 'ARCHIVE_INDEX_INVALID', 'Replay minute index');
  if (!Array.isArray(value)) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index must be an array.');

  const seen = new Set();
  let previousAt = -Infinity;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid entry.');
    const [minute, at] = entry;
    if (!MINUTE.test(minute) || !Number.isSafeInteger(at) || at <= previousAt || seen.has(minute)) {
      fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid entry.');
    }
    const hour = Number(minute.slice(0, 2));
    const minuteOfHour = Number(minute.slice(2));
    if (hour > 23 || minuteOfHour > 59) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid time.');
    previousAt = at;
    seen.add(minute);
  }
  return value;
}

function readSource(scanDir, date) {
  requireDate(date);
  const day = path.join(scanDir, date);
  if (!fs.existsSync(day) || !fs.statSync(day).isDirectory()) fail('ARCHIVE_MISSING', `No captured session for ${date}.`);
  let indexBytes;
  try { indexBytes = fs.readFileSync(path.join(day, INDEX_FILE)); }
  catch { fail('ARCHIVE_MISSING', `Replay minute index is missing for ${date}.`); }
  const minutesIndex = sourceIndex(scanDir, date);
  const minutes = {};
  const sourceFiles = [{ name: INDEX_FILE, bytes: indexBytes }];
  for (const [minute] of minutesIndex) {
    const file = path.join(day, `${minute}.json`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('ARCHIVE_MISSING', `Minute ${minute} is missing for ${date}.`);
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch { fail('ARCHIVE_MISSING', `Minute ${minute} is missing for ${date}.`); }
    try { minutes[minute] = JSON.parse(bytes.toString('utf8')); }
    catch { fail('ARCHIVE_JSON_INVALID', `Minute ${minute} is not valid JSON.`); }
    sourceFiles.push({ name: `${minute}.json`, bytes });
  }

  const futures = {};
  const futuresDir = path.join(day, 'futures');
  if (fs.existsSync(futuresDir)) {
    if (!fs.statSync(futuresDir).isDirectory()) fail('ARCHIVE_FUTURES_INVALID', `Futures storage for ${date} is not a directory.`);
    for (const entry of fs.readdirSync(futuresDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.json')) continue;
      const symbol = entry.name.slice(0, -5);
      if (!SYMBOL.test(symbol) || !entry.isFile()) fail('ARCHIVE_FUTURES_INVALID', `Invalid futures file ${entry.name}.`);
      const file = path.join(futuresDir, entry.name);
      let bytes;
      try { bytes = fs.readFileSync(file); }
      catch { fail('ARCHIVE_MISSING', `Futures ${symbol} is missing for ${date}.`); }
      try { futures[symbol] = JSON.parse(bytes.toString('utf8')); }
      catch { fail('ARCHIVE_JSON_INVALID', `Futures ${symbol} is not valid JSON.`); }
      sourceFiles.push({ name: `futures/${entry.name}`, bytes });
    }
  }

  const chains = readChainSnapshots(day, date, sourceFiles);

  const fingerprintHash = crypto.createHash('sha256');
  for (const source of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
    fingerprintHash.update(source.name).update('\0').update(source.bytes).update('\0');
  }
  return { minutesIndex, minutes, futures, chains, sourceFingerprint: `sha256:${fingerprintHash.digest('hex')}` };
}

function payloadShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ARCHIVE_SHAPE_INVALID', 'Archive payload must be an object.');
  if (value.schemaVersion !== 1) fail('ARCHIVE_SCHEMA_UNKNOWN', 'Archive schema version is not supported.');
  if (typeof value.providerId !== 'string' || !PROVIDER.test(value.providerId)) fail('ARCHIVE_SHAPE_INVALID', 'Archive providerId is invalid.');
  if (!validDate(value.date)) fail('ARCHIVE_SHAPE_INVALID', 'Archive date is invalid.');
  if (!Array.isArray(value.minutesIndex) || !value.minutes || typeof value.minutes !== 'object' || Array.isArray(value.minutes) || !value.futures || typeof value.futures !== 'object' || Array.isArray(value.futures)) {
    fail('ARCHIVE_SHAPE_INVALID', 'Archive payload has an invalid shape.');
  }
  const minuteKeys = new Set();
  for (const entry of value.minutesIndex) {
    if (!Array.isArray(entry) || entry.length !== 2 || !MINUTE.test(entry[0]) || !Number.isSafeInteger(entry[1]) || minuteKeys.has(entry[0])) fail('ARCHIVE_SHAPE_INVALID', 'Archive minutesIndex is invalid.');
    minuteKeys.add(entry[0]);
  }
  if (Object.keys(value.minutes).some(key => !minuteKeys.has(key)) || minuteKeys.size !== Object.keys(value.minutes).length) fail('ARCHIVE_SHAPE_INVALID', 'Archive minutes do not match minutesIndex.');
  if (Object.keys(value.futures).some(key => !SYMBOL.test(key))) fail('ARCHIVE_SHAPE_INVALID', 'Archive futures symbols are invalid.');
  for (const [symbol, snapshot] of Object.entries(value.futures)) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.symbol !== symbol || snapshot.session !== value.date || !Array.isArray(snapshot.months)) {
      fail('ARCHIVE_SHAPE_INVALID', `Archive futures ${symbol} is invalid.`);
    }
    for (const month of snapshot.months) {
      if (!month || typeof month !== 'object' || !validDate(month.date) || !Array.isArray(month.candles)) fail('ARCHIVE_SHAPE_INVALID', `Archive futures ${symbol} has an invalid month.`);
      for (const candle of month.candles) {
        if (!candle || !Number.isSafeInteger(candle.at) || !Number.isFinite(candle.close) || !Number.isFinite(candle.oi)) fail('ARCHIVE_SHAPE_INVALID', `Archive futures ${symbol} has an invalid candle.`);
      }
    }
  }
  if (value.chains != null && (!value.chains || typeof value.chains !== 'object' || Array.isArray(value.chains))) fail('ARCHIVE_SHAPE_INVALID', 'Archive chains must be an object.');
  for (const [symbol, snapshots] of Object.entries(value.chains ?? {})) {
    if (!SYMBOL.test(symbol) || !Array.isArray(snapshots) || !snapshots.length
      || snapshots.some(snapshot => !isFullOptionChainSnapshot(snapshot, symbol, value.date))) fail('ARCHIVE_SHAPE_INVALID', `Archive chain ${symbol} is invalid.`);
  }
  return value;
}

function readArchivePayload(file) {
  let compressed;
  try { compressed = fs.readFileSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('ARCHIVE_MISSING', 'Archive gzip is missing.');
    fail('ARCHIVE_GZIP_INVALID', 'Archive gzip could not be read.');
  }
  let json;
  try { json = gunzipSync(compressed).toString('utf8'); }
  catch { fail('ARCHIVE_GZIP_INVALID', 'Archive gzip is corrupt.'); }
  let value;
  try { value = JSON.parse(json); }
  catch { fail('ARCHIVE_JSON_INVALID', 'Archive payload is not valid JSON.'); }
  return payloadShape(value);
}

function bytesFingerprint(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function archiveFingerprintSync(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch { fail('ARCHIVE_GZIP_INVALID', 'Archive gzip could not be read.'); }
  return bytesFingerprint(bytes);
}

async function archiveFingerprintAsync(file) {
  let bytes;
  try { bytes = await fsp.readFile(file); }
  catch { fail('ARCHIVE_GZIP_INVALID', 'Archive gzip could not be read.'); }
  return bytesFingerprint(bytes);
}

function spotCheckPayload(payload, identity = null) {
  const minute = payload.minutesIndex[0]?.[0];
  if (minute === undefined || !Object.prototype.hasOwnProperty.call(payload.minutes, minute)) fail('ARCHIVE_VERIFY_FAILED', 'Archive minute spot-check failed.');
  const symbol = Object.keys(payload.futures)[0];
  if (symbol !== undefined && (!payload.futures[symbol] || payload.futures[symbol].symbol !== symbol || payload.futures[symbol].session !== payload.date)) fail('ARCHIVE_VERIFY_FAILED', 'Archive futures spot-check failed.');
  const chainSymbol = Object.keys(payload.chains ?? {})[0];
  if (chainSymbol !== undefined && !payload.chains[chainSymbol].every(snapshot => isFullOptionChainSnapshot(snapshot, chainSymbol, payload.date))) fail('ARCHIVE_VERIFY_FAILED', 'Archive chain spot-check failed.');
  if (identity && (payload.providerId !== identity.providerId || payload.date !== identity.date)) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
}

function spotCheck(payload, source) {
  const minute = source?.minutesIndex?.[0]?.[0];
  if (minute !== undefined && JSON.stringify(payload.minutes[minute]) !== JSON.stringify(source.minutes[minute])) fail('ARCHIVE_VERIFY_FAILED', `Archive minute ${minute} failed verification.`);
  const symbol = Object.keys(source?.futures ?? {})[0];
  if (symbol !== undefined && JSON.stringify(payload.futures[symbol]) !== JSON.stringify(source.futures[symbol])) fail('ARCHIVE_VERIFY_FAILED', `Archive futures ${symbol} failed verification.`);
  const chainSymbol = Object.keys(source?.chains ?? {})[0];
  if (chainSymbol !== undefined && JSON.stringify(payload.chains?.[chainSymbol]) !== JSON.stringify(source.chains[chainSymbol])) fail('ARCHIVE_VERIFY_FAILED', `Archive chain ${chainSymbol} failed verification.`);
}

function verifyArchive(file, source = null, identity = null) {
  const payload = readArchivePayload(file);
  spotCheckPayload(payload, identity);
  if (identity && (payload.providerId !== identity.providerId || payload.date !== identity.date)) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
  if (source) {
    if (payload.providerId !== source.providerId || payload.date !== source.date) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
    if (JSON.stringify(payload.minutesIndex) !== JSON.stringify(source.minutesIndex)) fail('ARCHIVE_VERIFY_FAILED', 'Archive minute index failed verification.');
  }
  spotCheck(payload, source);
  return payload;
}

async function readJsonAsync(file, code, label) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('ARCHIVE_MISSING', `${label} is missing.`);
    fail(code, `Unable to read ${label}.`);
  }
  try { return JSON.parse(text); }
  catch { fail(code, `${label} is not valid JSON.`); }
}

async function readChainSnapshotsAsync(day, date, sourceFiles) {
  const dir = path.join(day, 'chains');
  let stat;
  try { stat = await fsp.stat(dir); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  if (!stat.isDirectory()) fail('ARCHIVE_CHAIN_INVALID', `Chain storage for ${date} is not a directory.`);
  const chains = {};
  const dirEntries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.json')) continue;
    const symbol = entry.name.slice(0, -5);
    if (!SYMBOL.test(symbol) || !entry.isFile()) fail('ARCHIVE_CHAIN_INVALID', `Invalid chain file ${entry.name}.`);
    const file = path.join(dir, entry.name);
    let bytes;
    try { bytes = await fsp.readFile(file); }
    catch { fail('ARCHIVE_MISSING', `Chain snapshot ${symbol} is missing for ${date}.`); }
    let snapshot;
    try { snapshot = JSON.parse(bytes.toString('utf8')); }
    catch { fail('ARCHIVE_JSON_INVALID', `Chain snapshot ${symbol} is not valid JSON.`); }
    if (!isFullOptionChainSnapshotCollection(snapshot, symbol, date)) fail('ARCHIVE_CHAIN_INVALID', `Chain snapshot ${symbol} is invalid for ${date}.`);
    chains[symbol] = snapshot.snapshots;
    sourceFiles.push({ name: `chains/${entry.name}`, bytes });
  }
  return chains;
}

async function readSourceAsync(scanDir, date) {
  requireDate(date);
  const day = path.join(scanDir, date);
  let dayStat;
  try { dayStat = await fsp.stat(day); } catch { fail('ARCHIVE_MISSING', `No captured session for ${date}.`); }
  if (!dayStat.isDirectory()) fail('ARCHIVE_MISSING', `No captured session for ${date}.`);

  const indexFile = path.join(day, INDEX_FILE);
  let indexBytes;
  try { indexBytes = await fsp.readFile(indexFile); } catch { fail('ARCHIVE_MISSING', `Replay minute index is missing for ${date}.`); }
  const minutesIndex = sourceIndexValue(await readJsonAsync(indexFile, 'ARCHIVE_INDEX_INVALID', 'Replay minute index'));
  const minutes = {};
  const sourceFiles = [{ name: INDEX_FILE, bytes: indexBytes }];
  for (const [minute] of minutesIndex) {
    const file = path.join(day, `${minute}.json`);
    let bytes;
    try { bytes = await fsp.readFile(file); } catch { fail('ARCHIVE_MISSING', `Minute ${minute} is missing for ${date}.`); }
    try { minutes[minute] = JSON.parse(bytes.toString('utf8')); }
    catch { fail('ARCHIVE_JSON_INVALID', `Minute ${minute} is not valid JSON.`); }
    sourceFiles.push({ name: `${minute}.json`, bytes });
  }

  const futures = {};
  const futuresDir = path.join(day, 'futures');
  try {
    const stat = await fsp.stat(futuresDir);
    if (!stat.isDirectory()) fail('ARCHIVE_FUTURES_INVALID', `Futures storage for ${date} is not a directory.`);
    const dirEntries = await fsp.readdir(futuresDir, { withFileTypes: true });
    for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.json')) continue;
      const symbol = entry.name.slice(0, -5);
      if (!SYMBOL.test(symbol) || !entry.isFile()) fail('ARCHIVE_FUTURES_INVALID', `Invalid futures file ${entry.name}.`);
      const file = path.join(futuresDir, entry.name);
      let bytes;
      try { bytes = await fsp.readFile(file); } catch { fail('ARCHIVE_MISSING', `Futures ${symbol} is missing for ${date}.`); }
      try { futures[symbol] = JSON.parse(bytes.toString('utf8')); }
      catch { fail('ARCHIVE_JSON_INVALID', `Futures ${symbol} is not valid JSON.`); }
      sourceFiles.push({ name: `futures/${entry.name}`, bytes });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const chains = await readChainSnapshotsAsync(day, date, sourceFiles);

  const fingerprintHash = crypto.createHash('sha256');
  for (const source of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) fingerprintHash.update(source.name).update('\0').update(source.bytes).update('\0');
  return { minutesIndex, minutes, futures, chains, sourceFingerprint: `sha256:${fingerprintHash.digest('hex')}` };
}

function sourceIndexValue(value) {
  if (!Array.isArray(value)) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index must be an array.');
  const seen = new Set();
  let previousAt = -Infinity;
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid entry.');
    const [minute, at] = entry;
    if (!MINUTE.test(minute) || !Number.isSafeInteger(at) || at <= previousAt || seen.has(minute)) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid entry.');
    const hour = Number(minute.slice(0, 2));
    const minuteOfHour = Number(minute.slice(2));
    if (hour > 23 || minuteOfHour > 59) fail('ARCHIVE_INDEX_INVALID', 'Replay minute index has an invalid time.');
    previousAt = at;
    seen.add(minute);
  }
  return value;
}

async function readArchivePayloadAsync(file, identity = null, expectedFingerprint = null) {
  let compressed;
  try { compressed = await fsp.readFile(file); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('ARCHIVE_MISSING', 'Archive gzip is missing.');
    fail('ARCHIVE_GZIP_INVALID', 'Archive gzip could not be read.');
  }
  let json;
  try { json = (await gunzipAsync(compressed)).toString('utf8'); }
  catch { fail('ARCHIVE_GZIP_INVALID', 'Archive gzip is corrupt.'); }
  let value;
  try { value = JSON.parse(json); }
  catch { fail('ARCHIVE_JSON_INVALID', 'Archive payload is not valid JSON.'); }
  const payload = payloadShape(value);
  spotCheckPayload(payload, identity);
  if (expectedFingerprint && bytesFingerprint(compressed) !== expectedFingerprint) fail('ARCHIVE_VERIFY_FAILED', 'Archive byte fingerprint failed verification.');
  return payload;
}

async function readIndexedArchivePayload(archiveRoot, providerId, date) {
  const entries = await readArchiveIndexAsync(path.resolve(archiveRoot));
  const entry = entries.find(candidate => candidate.providerId === providerId && candidate.date === date);
  if (!entry) fail('ARCHIVE_MISSING', `No archive for ${date}.`);
  if (!entry.archiveFingerprint) fail('ARCHIVE_VERIFY_FAILED', 'Archive byte fingerprint is missing.');
  return readArchivePayloadAsync(archivePath(archiveRoot, providerId, date), { providerId, date }, entry.archiveFingerprint);
}

async function verifyArchiveAsync(file, source = null, identity = null) {
  const payload = await readArchivePayloadAsync(file);
  if (identity && (payload.providerId !== identity.providerId || payload.date !== identity.date)) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
  if (source) {
    if (payload.providerId !== source.providerId || payload.date !== source.date) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
    if (JSON.stringify(payload.minutesIndex) !== JSON.stringify(source.minutesIndex)) fail('ARCHIVE_VERIFY_FAILED', 'Archive minute index failed verification.');
    for (const minute of Object.keys(source.minutes)) if (JSON.stringify(payload.minutes[minute]) !== JSON.stringify(source.minutes[minute])) fail('ARCHIVE_VERIFY_FAILED', `Archive minute ${minute} failed verification.`);
    for (const symbol of Object.keys(source.futures)) if (JSON.stringify(payload.futures[symbol]) !== JSON.stringify(source.futures[symbol])) fail('ARCHIVE_VERIFY_FAILED', `Archive futures ${symbol} failed verification.`);
    for (const symbol of Object.keys(source.chains ?? {})) if (JSON.stringify(payload.chains?.[symbol]) !== JSON.stringify(source.chains[symbol])) fail('ARCHIVE_VERIFY_FAILED', `Archive chain ${symbol} failed verification.`);
  }
  spotCheckPayload(payload, identity);
  return payload;
}

function readArchiveIndex(archiveRoot) {
  const file = path.join(archiveRoot, INDEX_FILE);
  if (!fs.existsSync(file)) return [];
  const value = readJson(file, 'ARCHIVE_INDEX_INVALID', 'Archive index');
  const entries = Array.isArray(value) ? value : value?.schemaVersion === 1 && Array.isArray(value.archives) ? value.archives : null;
  return validateArchiveEntries(entries);
}

function validateArchiveEntries(entries) {
  if (!Array.isArray(entries)) fail('ARCHIVE_INDEX_INVALID', 'Archive index must be an array.');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !validDate(entry.date) || typeof entry.providerId !== 'string' || !PROVIDER.test(entry.providerId) || !Number.isSafeInteger(entry.minutesCount) || !Array.isArray(entry.futuresSymbols) || entry.futuresSymbols.some(symbol => !SYMBOL.test(symbol)) || !Number.isSafeInteger(entry.sizeBytes) || typeof entry.archivedAt !== 'string' || typeof entry.sourceFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.sourceFingerprint)) fail('ARCHIVE_INDEX_INVALID', 'Archive index has an invalid entry.');
    if (entry.firstAt != null && !Number.isSafeInteger(entry.firstAt)) fail('ARCHIVE_INDEX_INVALID', 'Archive index has an invalid firstAt.');
    if (entry.lastAt != null && !Number.isSafeInteger(entry.lastAt)) fail('ARCHIVE_INDEX_INVALID', 'Archive index has an invalid lastAt.');
    if (entry.archiveFingerprint != null && !/^sha256:[0-9a-f]{64}$/.test(entry.archiveFingerprint)) fail('ARCHIVE_INDEX_INVALID', 'Archive index has an invalid archive fingerprint.');
    if (entry.futuresCoverage != null && (!entry.futuresCoverage || typeof entry.futuresCoverage !== 'object' || Array.isArray(entry.futuresCoverage))) fail('ARCHIVE_INDEX_INVALID', 'Archive index has invalid futures coverage.');
  }
  return entries;
}

async function readArchiveIndexAsync(archiveRoot) {
  const file = path.join(archiveRoot, INDEX_FILE);
  let value;
  try { value = await readJsonAsync(file, 'ARCHIVE_INDEX_INVALID', 'Archive index'); }
  catch (error) {
    if (error?.code === 'ARCHIVE_MISSING') return [];
    throw error;
  }
  const entries = Array.isArray(value) ? value : value?.schemaVersion === 1 && Array.isArray(value.archives) ? value.archives : null;
  return validateArchiveEntries(entries);
}

function writeArchiveIndex(archiveRoot, entries) {
  fs.mkdirSync(archiveRoot, { recursive: true });
  const temporary = path.join(archiveRoot, `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(entries));
    fs.renameSync(temporary, path.join(archiveRoot, INDEX_FILE));
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

async function writeArchiveIndexAsync(archiveRoot, entries) {
  await fsp.mkdir(archiveRoot, { recursive: true });
  const temporary = path.join(archiveRoot, `.index.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temporary, JSON.stringify(entries));
    await fsp.rename(temporary, path.join(archiveRoot, INDEX_FILE));
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

function keepCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : DEFAULT_KEEP;
}

function metadataFor(payload, file, archivedAt, sourceFingerprint) {
  const futuresCoverage = Object.fromEntries(Object.entries(payload.futures).map(([symbol, value]) => [symbol, coverageFor(value)]));
  const firstAt = payload.minutesIndex[0]?.[1] ?? null;
  const lastAt = payload.minutesIndex.at(-1)?.[1] ?? null;
  return {
    providerId: payload.providerId,
    date: payload.date,
    minutesCount: payload.minutesIndex.length,
    futuresSymbols: Object.keys(payload.futures).sort(),
    sizeBytes: fs.statSync(file).size,
    archiveFingerprint: archiveFingerprintSync(file),
    firstAt,
    lastAt,
    futuresCoverage,
    archivedAt,
    sourceFingerprint,
  };
}

async function metadataForAsync(payload, file, archivedAt, sourceFingerprint) {
  const stat = await fsp.stat(file);
  const futuresCoverage = Object.fromEntries(Object.entries(payload.futures).map(([symbol, value]) => [symbol, coverageFor(value)]));
  const firstAt = payload.minutesIndex[0]?.[1] ?? null;
  const lastAt = payload.minutesIndex.at(-1)?.[1] ?? null;
  return {
    providerId: payload.providerId,
    date: payload.date,
    minutesCount: payload.minutesIndex.length,
    futuresSymbols: Object.keys(payload.futures).sort(),
    sizeBytes: stat.size,
    archiveFingerprint: await archiveFingerprintAsync(file),
    firstAt,
    lastAt,
    futuresCoverage,
    archivedAt,
    sourceFingerprint,
  };
}

function coverageFor(snapshot) {
  const months = Array.isArray(snapshot?.months) ? snapshot.months : [];
  const candles = months.flatMap(month => Array.isArray(month?.candles) ? month.candles : []).filter(candle => Number.isSafeInteger(candle?.at));
  const firstAt = candles.length ? Math.min(...candles.map(candle => candle.at)) : null;
  const lastAt = candles.length ? Math.max(...candles.map(candle => candle.at)) : null;
  return {
    available: candles.length > 0,
    months: months.map(month => month.date),
    firstAt,
    lastAt,
    start: firstAt,
    end: lastAt == null ? null : lastAt + 60_000,
  };
}

function removeOlder({ archiveRoot, scanDir, entries, providerId, keep }) {
  const providerEntries = entries.filter(entry => entry.providerId === providerId).sort((a, b) => b.date.localeCompare(a.date));
  const expired = providerEntries.slice(keep);
  if (!expired.length) return false;
  for (const entry of expired) {
    if (!entry.archiveFingerprint || archiveFingerprintSync(archivePath(archiveRoot, entry.providerId, entry.date)) !== entry.archiveFingerprint) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} byte fingerprint failed verification.`);
    const payload = verifyArchive(archivePath(archiveRoot, entry.providerId, entry.date), null, entry);
    const symbols = Object.keys(payload.futures).sort();
    if (!symbols.length || payload.minutesIndex.length !== entry.minutesCount || JSON.stringify(symbols) !== JSON.stringify([...entry.futuresSymbols].sort())) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} content failed verification.`);
  }
  const retained = entries.filter(entry => !expired.includes(entry));
  writeArchiveIndex(archiveRoot, retained);
  for (const entry of expired) {
    fs.rmSync(archivePath(archiveRoot, entry.providerId, entry.date), { force: true });
    fs.rmSync(path.join(scanDir, entry.date), { recursive: true, force: true });
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  }
  return true;
}

async function verifyRetentionArchive(file, entry) {
  if (!entry.archiveFingerprint) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} has no byte fingerprint.`);
  if (await archiveFingerprintAsync(file) !== entry.archiveFingerprint) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} byte fingerprint failed verification.`);
  const payload = await verifyArchiveAsync(file, null, entry);
  if (payload.minutesIndex.length !== entry.minutesCount) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} minute count failed verification.`);
  const symbols = Object.keys(payload.futures).sort();
  if (!symbols.length) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} has no futures file to verify.`);
  if (JSON.stringify(symbols) !== JSON.stringify([...entry.futuresSymbols].sort())) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} futures failed verification.`);
  if (entry.firstAt != null && payload.minutesIndex[0]?.[1] !== entry.firstAt) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} first minute failed verification.`);
  if (entry.lastAt != null && payload.minutesIndex.at(-1)?.[1] !== entry.lastAt) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} last minute failed verification.`);
  for (const symbol of symbols) {
    const expected = entry.futuresCoverage?.[symbol];
    if (expected && JSON.stringify(coverageFor(payload.futures[symbol])) !== JSON.stringify(expected)) fail('ARCHIVE_VERIFY_FAILED', `Archive ${entry.date} futures coverage failed verification.`);
  }
  spotCheckPayload(payload, entry);
  return payload;
}

async function removeOlderAsync({ archiveRoot, scanDir, entries, providerId, keep }) {
  const providerEntries = entries.filter(entry => entry.providerId === providerId).sort((a, b) => b.date.localeCompare(a.date));
  const expired = providerEntries.slice(keep);
  if (!expired.length) return false;
  for (const entry of expired) await verifyRetentionArchive(archivePath(archiveRoot, entry.providerId, entry.date), entry);

  const retained = entries.filter(entry => !expired.includes(entry));
  // Publish the index before deleting any listed archive. Orphaned files are safe;
  // an index pointing at a deleted gzip is not.
  await writeArchiveIndexAsync(archiveRoot, retained);
  for (const entry of expired) {
    await fsp.rm(path.join(scanDir, entry.date), { recursive: true, force: true });
    await fsp.rm(archivePath(archiveRoot, entry.providerId, entry.date), { force: true });
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
  }
  return true;
}

export async function archiveSession(scanDir, providerId, date, options = {}) {
  requireDate(date);
  const archiveRoot = path.resolve(options.archiveRoot || path.join(path.dirname(scanDir), 'archives'));
  const target = archivePath(archiveRoot, providerId, date);
  const entries = await readArchiveIndexAsync(archiveRoot);
  const previous = entries.find(entry => entry.providerId === providerId && entry.date === date);
  const rawDay = path.join(scanDir, date);
  let source = null;
  let rawExists = false;
  try { rawExists = (await fsp.stat(rawDay)).isDirectory(); } catch { /* absent raw session */ }
  if (rawExists) source = await readSourceAsync(scanDir, date);

  if (!source && previous) {
    await verifyRetentionArchive(target, previous);
    const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
    await removeOlderAsync({ archiveRoot, scanDir, entries, providerId, keep });
    return entries.find(entry => entry.providerId === providerId && entry.date === date) || previous;
  }
  if (!source) fail('ARCHIVE_MISSING', `No captured session for ${date}.`);
  source.providerId = providerId;
  source.date = date;

  if (previous?.sourceFingerprint === source.sourceFingerprint) {
    try {
      await verifyArchiveAsync(target, source, { providerId, date });
      const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
      await removeOlderAsync({ archiveRoot, scanDir, entries, providerId, keep });
      await fsp.rm(rawDay, { recursive: true, force: true });
      return previous;
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
    }
  }

  const payload = {
    schemaVersion: 1,
    providerId,
    date,
    minutesIndex: source.minutesIndex,
    minutes: source.minutes,
    futures: source.futures,
    ...(Object.keys(source.chains ?? {}).length ? { chains: source.chains } : {}),
  };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${date}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(temporary, await gzipAsync(Buffer.from(JSON.stringify(payload))));
    await fsp.rename(temporary, target);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  await verifyArchiveAsync(target, source);
  const archivedAt = typeof options.now === 'function' ? options.now() : Date.now();
  const metadata = await metadataForAsync(payload, target, new Date(archivedAt).toISOString(), source.sourceFingerprint);
  const withoutPrevious = entries.filter(entry => !(entry.providerId === providerId && entry.date === date));
  withoutPrevious.push(metadata);
  withoutPrevious.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.date.localeCompare(b.date));
  await writeArchiveIndexAsync(archiveRoot, withoutPrevious);
  const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
  await removeOlderAsync({ archiveRoot, scanDir, entries: withoutPrevious, providerId, keep });
  await fsp.rm(rawDay, { recursive: true, force: true });
  return withoutPrevious.find(entry => entry.providerId === providerId && entry.date === date) || metadata;
}

export const archiveSessionAsync = archiveSession;

// Legacy test/helper path only. The server uses the async archiveSession above.
export function archiveSessionSync(scanDir, providerId, date, options = {}) {
  requireDate(date);
  const archiveRoot = path.resolve(options.archiveRoot || path.join(path.dirname(scanDir), 'archives'));
  const target = archivePath(archiveRoot, providerId, date);
  const entries = readArchiveIndex(archiveRoot);
  const previous = entries.find(entry => entry.providerId === providerId && entry.date === date);
  const rawDay = path.join(scanDir, date);
  let source = null;
  if (fs.existsSync(rawDay)) {
    source = readSource(scanDir, date);
    source.providerId = providerId;
    source.date = date;
  } else if (previous && fs.existsSync(target)) {
    verifyArchive(target, null, { providerId, date });
    const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
    removeOlder({ archiveRoot, scanDir, entries, providerId, keep });
    return entries.find(entry => entry.providerId === providerId && entry.date === date) || previous;
  } else {
    fail('ARCHIVE_MISSING', `No captured session for ${date}.`);
  }

  if (previous?.sourceFingerprint === source.sourceFingerprint && fs.existsSync(target)) {
    try {
      verifyArchive(target, source, { providerId, date });
      const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
      removeOlder({ archiveRoot, scanDir, entries, providerId, keep });
      cleanArchivedRawDay(rawDay);
      return previous;
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
    }
  }

  const payload = {
    schemaVersion: 1,
    providerId,
    date,
    minutesIndex: source.minutesIndex,
    minutes: source.minutes,
    futures: source.futures,
    ...(Object.keys(source.chains ?? {}).length ? { chains: source.chains } : {}),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${date}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, gzipSync(JSON.stringify(payload)));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  verifyArchive(target, source);
  const archivedAt = typeof options.now === 'function' ? options.now() : Date.now();
  const metadata = metadataFor(payload, target, new Date(archivedAt).toISOString(), source.sourceFingerprint);
  const withoutPrevious = entries.filter(entry => !(entry.providerId === providerId && entry.date === date));
  withoutPrevious.push(metadata);
  withoutPrevious.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.date.localeCompare(b.date));
  writeArchiveIndex(archiveRoot, withoutPrevious);
  const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
  removeOlder({ archiveRoot, scanDir, entries: withoutPrevious, providerId, keep });
  cleanArchivedRawDay(rawDay);
  return withoutPrevious.find(entry => entry.providerId === providerId && entry.date === date) || metadata;
}

/** After archiving, keep ONLY the day's last minute snapshot — it is the
 *  instant prev-day seed fuel for the next boot (one ~1.4 MB file/day). */
function cleanArchivedRawDay(rawDay) {
  let keep = null;
  try {
    const files = fs.readdirSync(rawDay).filter(f => /^\d{4}\.json$/.test(f)).sort();
    keep = files.length ? files[files.length - 1] : null;
  } catch { return; }
  for (const entry of fs.readdirSync(rawDay, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{4}\.json$/.test(entry.name) && entry.name === keep) continue;
    fs.rmSync(path.join(rawDay, entry.name), { recursive: true, force: true });
  }
}

export function listArchives(archiveRoot, providerId = null) {
  const entries = readArchiveIndex(path.resolve(archiveRoot));
  return entries
    .filter(entry => providerId == null || entry.providerId === providerId)
    .sort((a, b) => b.date.localeCompare(a.date) || a.providerId.localeCompare(b.providerId));
}

export function archiveMetadata(archiveRoot, providerId, date) {
  requireDate(date);
  return readArchiveIndex(path.resolve(archiveRoot)).find(entry => entry.providerId === providerId && entry.date === date) || null;
}

export function createArchiveService({ scanDir, providerId, archiveRoot = path.join(path.dirname(scanDir), 'archives'), keep = process.env.MF_ARCHIVE_KEEP, now = () => Date.now(), logger = console, beforeArchive = null } = {}) {
  const flights = new Map();
  const states = new Map();
  let serial = Promise.resolve();
  const stateFor = date => states.get(date) || { date, status: 'idle', result: null, error: null, startedAt: null, finishedAt: null };
  const report = (...args) => { if (typeof logger === 'function') logger(...args); else logger?.error?.(...args); };

  function enqueue(date) {
    requireDate(date);
    if (flights.has(date)) return stateFor(date);
    const state = { ...stateFor(date), date, status: 'queued', error: null, startedAt: now(), finishedAt: null };
    states.set(date, state);
    const work = serial.then(() => {
      state.status = 'running';
      return Promise.resolve(beforeArchive?.()).then(release => archiveSession(scanDir, providerId, date, { archiveRoot, keep, now }).finally(() => release?.()));
    }).then(result => {
      state.status = 'complete';
      state.result = result;
      state.finishedAt = now();
      return result;
    }).catch(error => {
      const archiveError = error instanceof ArchiveError ? error : new ArchiveError('ARCHIVE_FAILED', error?.message || 'Archive failed.');
      state.status = 'error';
      state.error = { code: archiveError.code, message: archiveError.message };
      state.finishedAt = now();
      report('archive failed:', archiveError.code, archiveError.message);
      return null;
    }).finally(() => flights.delete(date));
    serial = work.catch(() => {});
    flights.set(date, work);
    return state;
  }

  return {
    enqueue,
    archive: date => {
      enqueue(date);
      return flights.get(date) || Promise.resolve(stateFor(date).result);
    },
    status: date => ({ ...stateFor(date) }),
    list: () => listArchives(archiveRoot, providerId),
    metadata: date => archiveMetadata(archiveRoot, providerId, date),
    listAsync: () => readArchiveIndexAsync(path.resolve(archiveRoot)).then(entries => entries.filter(entry => entry.providerId === providerId).sort((a, b) => b.date.localeCompare(a.date) || a.providerId.localeCompare(b.providerId))),
    metadataAsync: date => readArchiveIndexAsync(path.resolve(archiveRoot)).then(entries => entries.find(entry => entry.providerId === providerId && entry.date === date) || null),
    readMinute: async (date, minute) => {
      requireDate(date);
      if (!validMinute(minute)) fail('ARCHIVE_MINUTE_INVALID', 'Invalid archive minute.');
      const payload = await readIndexedArchivePayload(archiveRoot, providerId, date);
      if (!Object.prototype.hasOwnProperty.call(payload.minutes, minute)) fail('ARCHIVE_MISSING', `Minute ${minute} is missing for ${date}.`);
      return payload.minutes[minute];
    },
    readFutures: async (date, symbol, asOf) => {
      requireDate(date);
      if (!validSymbol(symbol)) fail('ARCHIVE_SYMBOL_INVALID', 'Invalid archive futures symbol.');
      const cursor = archiveCursor(date, asOf);
      const payload = await readIndexedArchivePayload(archiveRoot, providerId, date);
      const result = payload.futures[symbol];
      if (!result) fail('ARCHIVE_MISSING', `Futures ${symbol} is missing for ${date}.`);
      return { symbol, session: date, months: result.months.map(month => ({ ...month, candles: month.candles.filter(candle => candle.at + 60_000 <= cursor) })) };
    },
    readFuturesSnapshot: async (date, symbol) => {
      requireDate(date);
      if (!validSymbol(symbol)) fail('ARCHIVE_SYMBOL_INVALID', 'Invalid archive futures symbol.');
      const payload = await readIndexedArchivePayload(archiveRoot, providerId, date);
      const result = payload.futures[symbol];
      if (!result) fail('ARCHIVE_MISSING', `Futures ${symbol} is missing for ${date}.`);
      return { symbol, session: date, months: result.months };
    },
    // One payload read for a whole session: callers that need many minutes
    // (strike series) must not re-gunzip the archive per minute.
    readSession: async date => {
      requireDate(date);
      const payload = await readIndexedArchivePayload(archiveRoot, providerId, date);
      return { minutesIndex: payload.minutesIndex, minutes: payload.minutes };
    },
    manifest: async date => {
      requireDate(date);
      const payload = await readIndexedArchivePayload(archiveRoot, providerId, date);
      const firstAt = payload.minutesIndex[0]?.[1] ?? null;
      const lastAt = payload.minutesIndex.at(-1)?.[1] ?? null;
      return {
        providerId,
        date,
        minutesIndex: payload.minutesIndex,
        minutes: payload.minutesIndex,
        firstAt,
        lastAt,
        start: firstAt,
        end: lastAt,
        range: { firstAt, lastAt },
        futures: Object.fromEntries(Object.entries(payload.futures).map(([symbol, value]) => [symbol, coverageFor(value)])),
        futuresSymbols: Object.keys(payload.futures).sort(),
      };
    },
  };
}

function routeError(error) {
  const archiveError = error instanceof ArchiveError ? error : new ArchiveError('ARCHIVE_FAILED', error?.message || 'Archive failed.');
  const badRequest = /^(ARCHIVE_(DATE|MINUTE|TIME|SYMBOL|PROVIDER|REQUEST|METHOD)_INVALID)$/.test(archiveError.code);
  return { status: archiveError.code === 'ARCHIVE_MISSING' ? 404 : badRequest ? 400 : 503, body: { error: archiveError.message, code: archiveError.code } };
}

function validMinute(minute) {
  if (typeof minute !== 'string' || !MINUTE.test(minute)) return false;
  return Number(minute.slice(0, 2)) <= 23 && Number(minute.slice(2)) <= 59;
}

function validSymbol(symbol) {
  return typeof symbol === 'string' && SYMBOL.test(symbol) && symbol === symbol.toUpperCase();
}

function archiveCursor(date, asOf) {
  if (typeof asOf !== 'string' || !validMinute(asOf)) fail('ARCHIVE_TIME_INVALID', 'asOf must be a market-session time in HHMM.');
  const at = Date.parse(`${date}T${asOf.slice(0, 2)}:${asOf.slice(2)}:00+05:30`);
  if (!Number.isFinite(at) || !isMarketSessionTime(at)) fail('ARCHIVE_TIME_INVALID', 'asOf must be a market-session time in HHMM.');
  const bounds = marketSessionBounds(at);
  if (at < bounds.open || at > bounds.close) fail('ARCHIVE_TIME_INVALID', 'asOf must be a market-session time in HHMM.');
  return at;
}

async function rawReplayDays(scanDir) {
  const days = [];
  let entries;
  try { entries = await fsp.readdir(scanDir, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return days; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !validDate(entry.name)) continue;
    const date = entry.name;
    let minutes;
    try { minutes = sourceIndexValue(await readJsonAsync(path.join(scanDir, date, INDEX_FILE), 'ARCHIVE_INDEX_INVALID', 'Replay minute index')); }
    catch (error) { if (error?.code === 'ARCHIVE_MISSING') continue; throw error; }
    const futuresSymbols = [];
    try {
      const futuresEntries = await fsp.readdir(path.join(scanDir, date, 'futures'), { withFileTypes: true });
      for (const future of futuresEntries) if (future.isFile() && future.name.endsWith('.json') && validSymbol(future.name.slice(0, -5))) futuresSymbols.push(future.name.slice(0, -5));
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    days.push({ date, source: 'live', minutes: minutes.length, firstAt: minutes[0]?.[1] ?? null, lastAt: minutes.at(-1)?.[1] ?? null, futuresSymbols: futuresSymbols.sort() });
  }
  return days;
}

export async function listReplayDays(scanDir, archiveRoot, providerId) {
  const merged = new Map((await rawReplayDays(scanDir)).map(day => [day.date, day]));
  const archives = (await readArchiveIndexAsync(path.resolve(archiveRoot))).filter(entry => entry.providerId === providerId);
  for (const entry of archives) {
    merged.set(entry.date, {
      date: entry.date,
      source: 'archive',
      minutes: entry.minutesCount,
      firstAt: entry.firstAt ?? null,
      lastAt: entry.lastAt ?? null,
      futuresSymbols: [...entry.futuresSymbols].sort(),
    });
  }
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
}

async function rawDayDirectoryExists(scanDir, date) {
  try { return (await fsp.stat(path.join(scanDir, date))).isDirectory(); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export async function readArchiveMinuteFallback(scanDir, service, date, minute) {
  if (await rawDayDirectoryExists(scanDir, date)) return null;
  return service.readMinute(date, minute);
}

export async function readArchiveFuturesFallback(scanDir, service, date, symbol) {
  if (await rawDayDirectoryExists(scanDir, date)) return null;
  return service.readFuturesSnapshot(date, symbol);
}

export function archiveRequest(method, requestUrl, service, logger = console) {
  if (!/^\/api\/archive(?:\/|\?|$)/.test(requestUrl ?? '')) return null;
  let url;
  try { url = new URL(requestUrl, 'http://localhost'); }
  catch { return { status: 400, body: { error: 'Bad request.', code: 'ARCHIVE_REQUEST_INVALID' } }; }
  let pathName;
  try { pathName = decodeURIComponent(url.pathname); }
  catch { return { status: 400, body: { error: 'Bad request.', code: 'ARCHIVE_REQUEST_INVALID' } }; }
  if (pathName === '/api/archive') {
    if (method !== 'GET') return { status: 400, body: { error: 'Archive date is required.', code: 'ARCHIVE_DATE_INVALID' } };
    try { return { status: 200, body: { archives: service.list() } }; }
    catch (error) { return routeError(error); }
  }
  const minutePath = pathName.match(/^\/api\/archive\/([^/]+)\/minute\/([^/]+)$/);
  if (minutePath) {
    const date = minutePath[1];
    const minute = minutePath[2];
    if (!validDate(date)) return { status: 400, body: { error: 'Invalid archive session date.', code: 'ARCHIVE_DATE_INVALID' } };
    if (!validMinute(minute)) return { status: 400, body: { error: 'Invalid archive minute.', code: 'ARCHIVE_MINUTE_INVALID' } };
    if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed.', code: 'ARCHIVE_METHOD_INVALID' } };
    try {
      const result = service.readMinute?.(date, minute);
      return result && typeof result.then === 'function' ? result.then(body => ({ status: 200, body, headers: ARCHIVE_DAY_CACHE })).catch(error => routeError(error)) : result ? { status: 200, body: result, headers: ARCHIVE_DAY_CACHE } : routeError(new ArchiveError('ARCHIVE_MISSING', 'Archive minute is missing.'));
    } catch (error) { return routeError(error); }
  }
  const futuresPath = pathName.match(/^\/api\/archive\/([^/]+)\/futures\/([^/]+)$/);
  if (futuresPath) {
    const date = futuresPath[1];
    const symbol = futuresPath[2].toUpperCase();
    if (!validDate(date)) return { status: 400, body: { error: 'Invalid archive session date.', code: 'ARCHIVE_DATE_INVALID' } };
    if (!validSymbol(symbol)) return { status: 400, body: { error: 'Invalid archive futures symbol.', code: 'ARCHIVE_SYMBOL_INVALID' } };
    if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed.', code: 'ARCHIVE_METHOD_INVALID' } };
    const asOf = url.searchParams.get('asOf');
    try {
      archiveCursor(date, asOf);
      const result = service.readFutures?.(date, symbol, asOf);
      return result && typeof result.then === 'function' ? result.then(body => ({ status: 200, body, headers: ARCHIVE_DAY_CACHE })).catch(error => routeError(error)) : result ? { status: 200, body: result, headers: ARCHIVE_DAY_CACHE } : routeError(new ArchiveError('ARCHIVE_MISSING', 'Archive futures are missing.'));
    } catch (error) { return routeError(error); }
  }
  const manifestPath = pathName.match(/^\/api\/archive\/([^/]+)\/manifest$/);
  if (manifestPath) {
    const date = manifestPath[1];
    if (!validDate(date)) return { status: 400, body: { error: 'Invalid archive session date.', code: 'ARCHIVE_DATE_INVALID' } };
    if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed.', code: 'ARCHIVE_METHOD_INVALID' } };
    try {
      const result = service.manifest?.(date);
      return result && typeof result.then === 'function' ? result.then(body => ({ status: 200, body })).catch(error => routeError(error)) : result ? { status: 200, body: result } : routeError(new ArchiveError('ARCHIVE_MISSING', 'Archive manifest is missing.'));
    } catch (error) { return routeError(error); }
  }
  const match = pathName.match(/^\/api\/archive\/([^/]+)$/);
  if (!match) return { status: 404, body: { error: 'Unknown archive request.', code: 'ARCHIVE_REQUEST_NOT_FOUND' } };
  const date = match[1];
  if (!validDate(date)) return { status: 400, body: { error: 'Invalid archive session date.', code: 'ARCHIVE_DATE_INVALID' } };
  if (method === 'POST') {
    try {
      const state = service.enqueue ? service.enqueue(date) : { date, status: 'queued' };
      if (!service.enqueue) Promise.resolve(service.archive(date)).catch(error => logger?.('archive trigger failed:', error?.message || error));
      return { status: 202, body: { archive: state } };
    } catch (error) { return routeError(error); }
  }
  if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed.', code: 'ARCHIVE_METHOD_INVALID' } };
  try {
    const metadata = service.metadata(date);
    return metadata ? { status: 200, body: metadata } : { status: 404, body: { error: 'No archive for that date.', code: 'ARCHIVE_MISSING' } };
  } catch (error) { return routeError(error); }
}

/** Async counterpart used by the HTTP server so archive index/metadata reads
 * never use synchronous filesystem calls on the live request path. */
export async function archiveRequestAsync(method, requestUrl, service, logger = console) {
  let url;
  try { url = new URL(requestUrl, 'http://localhost'); }
  catch { return { status: 400, body: { error: 'Bad request.', code: 'ARCHIVE_REQUEST_INVALID' } }; }
  let pathName;
  try { pathName = decodeURIComponent(url.pathname); }
  catch { return { status: 400, body: { error: 'Bad request.', code: 'ARCHIVE_REQUEST_INVALID' } }; }
  if (pathName === '/api/archive' && method === 'GET' && service?.listAsync) {
    try { return { status: 200, body: { archives: await service.listAsync() } }; }
    catch (error) { return routeError(error); }
  }
  const match = pathName.match(/^\/api\/archive\/([^/]+)$/);
  if (match && method === 'GET' && service?.metadataAsync) {
    const date = match[1];
    if (!validDate(date)) return { status: 400, body: { error: 'Invalid archive session date.', code: 'ARCHIVE_DATE_INVALID' } };
    try {
      const metadata = await service.metadataAsync(date);
      return metadata ? { status: 200, body: metadata } : { status: 404, body: { error: 'No archive for that date.', code: 'ARCHIVE_MISSING' } };
    } catch (error) { return routeError(error); }
  }
  return await archiveRequest(method, requestUrl, service, logger);
}

export { readArchiveIndex, readArchivePayload, verifyArchive };
