import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const ARCHIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = /^\d{4}$/;
const SYMBOL = /^[A-Z0-9&._-]{1,40}$/;
const PROVIDER = /^[A-Za-z0-9._-]{1,40}$/;
const INDEX_FILE = 'index.json';
const DEFAULT_KEEP = 30;

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

  const fingerprintHash = crypto.createHash('sha256');
  for (const source of sourceFiles.sort((a, b) => a.name.localeCompare(b.name))) {
    fingerprintHash.update(source.name).update('\0').update(source.bytes).update('\0');
  }
  return { minutesIndex, minutes, futures, sourceFingerprint: `sha256:${fingerprintHash.digest('hex')}` };
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

function spotCheck(payload, source) {
  const minute = source?.minutesIndex?.[0]?.[0];
  if (minute !== undefined && JSON.stringify(payload.minutes[minute]) !== JSON.stringify(source.minutes[minute])) fail('ARCHIVE_VERIFY_FAILED', `Archive minute ${minute} failed verification.`);
  const symbol = Object.keys(source?.futures ?? {})[0];
  if (symbol !== undefined && JSON.stringify(payload.futures[symbol]) !== JSON.stringify(source.futures[symbol])) fail('ARCHIVE_VERIFY_FAILED', `Archive futures ${symbol} failed verification.`);
}

function verifyArchive(file, source = null, identity = null) {
  const payload = readArchivePayload(file);
  if (identity && (payload.providerId !== identity.providerId || payload.date !== identity.date)) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
  if (source) {
    if (payload.providerId !== source.providerId || payload.date !== source.date) fail('ARCHIVE_VERIFY_FAILED', 'Archive identity failed verification.');
    if (JSON.stringify(payload.minutesIndex) !== JSON.stringify(source.minutesIndex)) fail('ARCHIVE_VERIFY_FAILED', 'Archive minute index failed verification.');
  }
  spotCheck(payload, source);
  return payload;
}

function readArchiveIndex(archiveRoot) {
  const file = path.join(archiveRoot, INDEX_FILE);
  if (!fs.existsSync(file)) return [];
  const value = readJson(file, 'ARCHIVE_INDEX_INVALID', 'Archive index');
  const entries = Array.isArray(value) ? value : value?.schemaVersion === 1 && Array.isArray(value.archives) ? value.archives : null;
  if (!entries) fail('ARCHIVE_INDEX_INVALID', 'Archive index must be an array.');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !validDate(entry.date) || typeof entry.providerId !== 'string' || !PROVIDER.test(entry.providerId) || !Number.isSafeInteger(entry.minutesCount) || !Array.isArray(entry.futuresSymbols) || entry.futuresSymbols.some(symbol => !SYMBOL.test(symbol)) || !Number.isSafeInteger(entry.sizeBytes) || typeof entry.archivedAt !== 'string' || typeof entry.sourceFingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.sourceFingerprint)) fail('ARCHIVE_INDEX_INVALID', 'Archive index has an invalid entry.');
  }
  return entries;
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

function keepCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : DEFAULT_KEEP;
}

function metadataFor(payload, file, archivedAt, sourceFingerprint) {
  return {
    providerId: payload.providerId,
    date: payload.date,
    minutesCount: payload.minutesIndex.length,
    futuresSymbols: Object.keys(payload.futures).sort(),
    sizeBytes: fs.statSync(file).size,
    archivedAt,
    sourceFingerprint,
  };
}

function removeOlder({ archiveRoot, scanDir, entries, providerId, keep }) {
  const providerEntries = entries.filter(entry => entry.providerId === providerId).sort((a, b) => b.date.localeCompare(a.date));
  const retained = new Set(providerEntries.slice(0, keep).map(entry => `${entry.providerId}/${entry.date}`));
  let changed = false;
  for (const entry of providerEntries.slice(keep)) {
    const key = `${entry.providerId}/${entry.date}`;
    if (retained.has(key)) continue;
    const file = archivePath(archiveRoot, entry.providerId, entry.date);
    // Verification is deliberately before either the gzip or raw day is removed.
    verifyArchive(file, null, entry);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    const raw = path.join(scanDir, entry.date);
    if (fs.existsSync(raw)) fs.rmSync(raw, { recursive: true, force: true });
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    changed = true;
    writeArchiveIndex(archiveRoot, entries);
  }
  return changed;
}

export function archiveSession(scanDir, providerId, date, options = {}) {
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
      fs.rmSync(rawDay, { recursive: true, force: true });
      removeOlder({ archiveRoot, scanDir, entries, providerId, keep });
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
  fs.rmSync(rawDay, { recursive: true, force: true });
  const keep = keepCount(options.keep ?? process.env.MF_ARCHIVE_KEEP);
  removeOlder({ archiveRoot, scanDir, entries: withoutPrevious, providerId, keep });
  return withoutPrevious.find(entry => entry.providerId === providerId && entry.date === date) || metadata;
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

export function createArchiveService({ scanDir, providerId, archiveRoot = path.join(path.dirname(scanDir), 'archives'), keep = process.env.MF_ARCHIVE_KEEP, now = () => Date.now(), logger = console } = {}) {
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
      const result = archiveSession(scanDir, providerId, date, { archiveRoot, keep, now });
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
  };
}

function routeError(error) {
  const archiveError = error instanceof ArchiveError ? error : new ArchiveError('ARCHIVE_FAILED', error?.message || 'Archive failed.');
  return { status: 503, body: { error: archiveError.message, code: archiveError.code } };
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
  const match = pathName.match(/^\/api\/archive\/([^/]+)$/);
  if (!match) return null;
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

export { readArchiveIndex, readArchivePayload, verifyArchive };
