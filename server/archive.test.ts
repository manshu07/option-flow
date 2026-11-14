import { describe, expect, it } from 'vitest';
import { buildSession, marketWalk, parseBhavcopy, rebuildOi, rebuildPath, unitsTraded } from '../scripts/fetch-nse-archive.mjs';

const HEAD = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';
const CSV = [
  HEAD,
  '2026-11-06,2026-11-06,FO,NSE,STF,1,,RELIANCE,,2026-11-23,2026-11-23,,,RELIANCE26NOVFUT,1301.00,1325.00,1301.00,1323.00,1321.20,1315.90,1319.99,1323.00,136395500,61000,29287,19271864800.00,,F1,500,,,,,',
  '2026-11-06,2026-11-06,FO,NSE,STO,2,,RELIANCE,,2026-11-23,2026-11-23,1320.00,CE,RELIANCE26NOV1320CE,20,30,18,24.85,24.85,21.45,1319.99,24.85,10355000,-385500,4434,2946000000,,F1,500,,,,,',
  '2026-11-06,2026-11-06,FO,NSE,STO,3,,RELIANCE,,2026-11-23,2026-11-23,1320.00,PE,RELIANCE26NOV1320PE,25,34,21.4,22.3,22.3,25.45,1319.99,22.3,1407500,-13500,11650,15530000000,,F1,500,,,,,',
].join('\n');

describe('NSE archive builder', () => {
  it('parses a UDiFF bhavcopy', () => {
    const rows = parseBhavcopy(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ type: 'STF', symbol: 'RELIANCE', expiry: '2026-11-23', open: 1301, high: 1325, close: 1323, oi: 136395500, lot: 500 });
  });

  it('reads volume in units whether the exchange reports contracts or units', () => {
    const [fut] = parseBhavcopy(CSV);
    expect(unitsTraded(fut)).toBe(29287 * 500);
    expect(unitsTraded({ ...fut, volume: 29287 * 500 })).toBe(29287 * 500);
  });

  it('rebuilds a path that opens, peaks, bottoms and closes on the real figures', () => {
    const bar = { open: 1301, high: 1325, low: 1298, close: 1323 };
    const path = rebuildPath(bar, 'x', marketWalk('2026-11-06'));
    expect(path).toHaveLength(375);
    expect(path[0]).toBe(1301);
    expect(path.at(-1)).toBe(1323);
    expect(Math.max(...path)).toBe(1325);
    expect(Math.min(...path)).toBe(1298);
    expect(rebuildPath(bar, 'x', marketWalk('2026-11-06'))).toEqual(path); // deterministic
  });

  it('moves open interest from the previous OI to the real closing OI in whole lots', () => {
    const oi = rebuildOi(136334500, 136395500, 500, 'x');
    expect(oi.at(-1)).toBe(136395500);
    expect(oi.every(v => v % 500 === 0)).toBe(true);
  });

  it('builds the chain and futures in the recorded-session shape', () => {
    const u = { symbol: 'RELIANCE', name: 'Reliance', kind: 'stock', exch: 'NSE', lot: 500 };
    const { chains, futures } = buildSession('2026-11-06', { NSE: parseBhavcopy(CSV) }, {}, [u]);
    const chain = chains.RELIANCE.chain;
    expect(chain).toMatchObject({ expiry: '2026-11-23', spot: 1319.99 });
    expect(chain.strikes[0].call).toMatchObject({ ltp: 24.85, oi: 10355000, prevOi: 10740500, volume: 4434 * 500 });
    expect(futures.RELIANCE[0]).toMatchObject({ date: '2026-11-23', prevClose: 1315.9, prevOi: 136334500 });
    expect(futures.RELIANCE[0].candles[0].at).toBe(Date.parse('2026-11-06T09:15:00+05:30'));
  });
});

const archiveFs = (await import('node:fs')).default;
const archiveOs = await import('node:os');
const archivePath = await import('node:path');
const { gunzipSync, gzipSync } = await import('node:zlib');
const {
  archiveMetadata,
  archiveRequest,
  archiveRequestAsync,
  archiveSession,
  createArchiveService,
  listReplayDays,
  listArchives,
  readArchiveFuturesFallback,
  readArchiveMinuteFallback,
  verifyArchive,
} = await import('./archive.mjs');

const S6_PROVIDER = 'fixture';
const S6_DATES = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];

function s6TempDir() {
  return archiveFs.mkdtempSync(archivePath.join(archiveOs.tmpdir(), 'of-archive-'));
}

function s6WriteDay(scanDir, date) {
  const day = archivePath.join(scanDir, date);
  archiveFs.mkdirSync(archivePath.join(day, 'futures'), { recursive: true });
  const minutes = [
    ['0915', Date.parse(`${date}T09:15:00+05:30`)],
    ['0916', Date.parse(`${date}T09:16:00+05:30`)],
    ['0917', Date.parse(`${date}T09:17:00+05:30`)],
  ];
  archiveFs.writeFileSync(archivePath.join(day, 'index.json'), JSON.stringify(minutes));
  const minuteSnapshots = Object.fromEntries(minutes.map(([minute, at]) => [minute, { date, minute, at, series: [{ symbol: 'NIFTY', value: Number(minute) }] }]));
  for (const [minute] of minutes) archiveFs.writeFileSync(archivePath.join(day, `${minute}.json`), JSON.stringify(minuteSnapshots[minute]));
  const futures = {};
  for (const symbol of ['ALPHA', 'BETA']) {
    const candles = [{ at: minutes[0][1], close: 100, oi: 10 }, { at: minutes[2][1], close: 102, oi: 12 }];
    futures[symbol] = { symbol, session: date, months: [{ date: '2026-12-31', prevClose: 99, prevOi: 9, candles }] };
    archiveFs.writeFileSync(archivePath.join(day, 'futures', `${symbol}.json`), JSON.stringify(futures[symbol]));
  }
  return { minutes, minuteSnapshots, futures, day };
}

function s6Paths(root) {
  return { scanDir: archivePath.join(root, S6_PROVIDER), archiveRoot: archivePath.join(root, 'archives') };
}

describe('Replay V2 S6 EOD archive', () => {
  it('round-trips a three-minute, two-symbol day and removes raw data only after verification', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const source = s6WriteDay(scanDir, S6_DATES[0]);
      const metadata = await archiveSession(scanDir, S6_PROVIDER, S6_DATES[0], { archiveRoot, keep: 30 });
      const file = archivePath.join(archiveRoot, S6_PROVIDER, `${S6_DATES[0]}.json.gz`);
      const payload = JSON.parse(gunzipSync(archiveFs.readFileSync(file), { level: 9 }).toString('utf8'));
      expect(payload).toEqual({
        schemaVersion: 1,
        providerId: S6_PROVIDER,
        date: S6_DATES[0],
        minutesIndex: source.minutes,
        minutes: source.minuteSnapshots,
        futures: source.futures,
      });
      expect(payload.futures.ALPHA.months[0].candles).toHaveLength(2);
      expect(metadata).toMatchObject({ providerId: S6_PROVIDER, date: S6_DATES[0], minutesCount: 3, futuresSymbols: ['ALPHA', 'BETA'], sizeBytes: expect.any(Number), sourceFingerprint: expect.stringMatching(/^sha256:/) });
      expect(archiveFs.existsSync(source.day)).toBe(false);
      expect(JSON.parse(archiveFs.readFileSync(archivePath.join(archiveRoot, 'index.json'), 'utf8'))).toEqual([metadata]);
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the newest two archives and removes older verified gzip/raw sessions', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      for (const date of S6_DATES) s6WriteDay(scanDir, date);
      for (const date of S6_DATES) await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot, keep: 2 });
      expect(listArchives(archiveRoot, S6_PROVIDER).map(entry => entry.date)).toEqual(['2026-11-13', '2026-11-12']);
      for (const date of S6_DATES.slice(0, 2)) {
        expect(archiveFs.existsSync(archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`))).toBe(false);
        expect(archiveFs.existsSync(archivePath.join(scanDir, date))).toBe(false);
      }
      const index = JSON.parse(archiveFs.readFileSync(archivePath.join(archiveRoot, 'index.json'), 'utf8'));
      expect(index).toHaveLength(2);
      expect(index.every(entry => entry.providerId === S6_PROVIDER && entry.minutesCount === 3 && entry.futuresSymbols.length === 2)).toBe(true);
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns structured errors for corrupt gzip, unknown schema, and malformed indexes', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[0];
      s6WriteDay(scanDir, date);
      await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot });
      const file = archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`);
      archiveFs.writeFileSync(file, Buffer.from('not gzip'));
      expect(() => verifyArchive(file)).toThrowError(expect.objectContaining({ code: 'ARCHIVE_GZIP_INVALID' }));
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify({ schemaVersion: 99 })));
      expect(() => verifyArchive(file)).toThrowError(expect.objectContaining({ code: 'ARCHIVE_SCHEMA_UNKNOWN' }));
      expect(archiveMetadata(archiveRoot, S6_PROVIDER, date)).toBeInstanceOf(Object);
      archiveFs.writeFileSync(archivePath.join(archiveRoot, 'index.json'), '{broken');
      expect(() => listArchives(archiveRoot, S6_PROVIDER)).toThrowError(expect.objectContaining({ code: 'ARCHIVE_INDEX_INVALID' }));
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('provides injectable 200/202/400/404/503 archive route contracts without provider reads', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[0];
      s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, keep: 30, logger: () => {} });
      expect(archiveRequest('GET', '/api/archive', service)).toMatchObject({ status: 200, body: { archives: [] } });
      expect(archiveRequest('POST', `/api/archive/${date}`, service)).toMatchObject({ status: 202, body: { archive: { date, status: 'queued' } } });
      await service.archive(date);
      expect(archiveRequest('GET', `/api/archive/${date}`, service)).toMatchObject({ status: 200, body: { providerId: S6_PROVIDER, date } });
      expect(archiveRequest('GET', '/api/archive/not-a-date', service)).toMatchObject({ status: 400, body: { code: 'ARCHIVE_DATE_INVALID' } });
      expect(archiveRequest('GET', '/api/archive/2026-11-14', service)).toMatchObject({ status: 404, body: { code: 'ARCHIVE_MISSING' } });
      archiveFs.writeFileSync(archivePath.join(archiveRoot, 'index.json'), 'nope');
      const unavailable = archiveRequest('GET', '/api/archive', { list: () => listArchives(archiveRoot, S6_PROVIDER) });
      expect(unavailable).toMatchObject({ status: 503, body: { code: 'ARCHIVE_INDEX_INVALID' } });
      const provider = { futures: () => { throw new Error('provider must not be called'); } };
      expect(archiveRequest('GET', `/api/archive/${date}`, { metadata: () => ({ providerId: S6_PROVIDER, date }), provider })).toMatchObject({ status: 200 });
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not rearchive unchanged raw data after a verified archive exists', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[0];
      s6WriteDay(scanDir, date);
      const first = await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot });
      expect(archiveFs.existsSync(archivePath.join(scanDir, date))).toBe(false);
      s6WriteDay(scanDir, date);
      const second = await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot });
      expect(second).toEqual(first);
      expect(archiveFs.existsSync(archivePath.join(scanDir, date))).toBe(false);
      expect(await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot })).toEqual(first);
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Replay V2 S7 archive read contracts', () => {
  it('serves an archived minute, completed futures candles, and manifest coverage', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      const source = s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, keep: 30, logger: () => {} });
      await service.archive(date);

      const minute = await archiveRequest('GET', `/api/archive/${date}/minute/0916`, service);
      expect(minute).toMatchObject({ status: 200, body: source.minuteSnapshots['0916'], headers: { 'Cache-Control': 'public, max-age=86400' } });

      const atBoundary = await archiveRequest('GET', `/api/archive/${date}/futures/ALPHA?asOf=0916`, service);
      expect(atBoundary).toMatchObject({ status: 200, body: { symbol: 'ALPHA', session: date }, headers: { 'Cache-Control': 'public, max-age=86400' } });
      expect(atBoundary.body.months[0].candles.map(candle => candle.at)).toEqual([source.minutes[0][1]]);

      const manifest = await archiveRequest('GET', `/api/archive/${date}/manifest`, service);
      expect(manifest).toMatchObject({
        status: 200,
        body: {
          providerId: S6_PROVIDER,
          date,
          minutesIndex: source.minutes,
          firstAt: source.minutes[0][1],
          lastAt: source.minutes.at(-1)[1],
          futures: { ALPHA: { available: true, firstAt: source.minutes[0][1], lastAt: source.minutes[2][1] } },
        },
      });
      expect((await archiveRequest('GET', '/api/archive', service)).body.archives[0]).toMatchObject({ firstAt: source.minutes[0][1], lastAt: source.minutes[2][1], futuresCoverage: expect.any(Object) });
      expect(archiveRequest('GET', `/api/archive/${date}/unknown`, service)).toMatchObject({ status: 404, body: { code: 'ARCHIVE_REQUEST_NOT_FOUND' } });
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns structured missing, corrupt-gzip, and unknown-schema responses without provider access', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, keep: 30, logger: () => {} });
      await service.archive(date);
      const listed = archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`);
      const validArchive = archiveFs.readFileSync(listed);
      archiveFs.writeFileSync(listed, Buffer.from('corrupt'));
      expect(archiveRequest('GET', '/api/archive', service)).toMatchObject({ status: 200, body: { archives: expect.any(Array) } });
      archiveFs.writeFileSync(listed, validArchive);
      expect(await archiveRequest('GET', `/api/archive/${date}/minute/0920`, service)).toMatchObject({ status: 404, body: { code: 'ARCHIVE_MISSING' } });
      expect(await archiveRequest('GET', `/api/archive/${date}/futures/ALPHA?asOf=0916`, service)).toMatchObject({ status: 200 });

      const file = archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`);
      archiveFs.writeFileSync(file, Buffer.from('corrupt'));
      expect(await archiveRequest('GET', `/api/archive/${date}/minute/0915`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_GZIP_INVALID' } });
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify({ schemaVersion: 99 })));
      expect(await archiveRequest('GET', `/api/archive/${date}/manifest`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_SCHEMA_UNKNOWN' } });
      expect(await archiveRequest('GET', `/api/archive/${date}/futures/ALPHA?asOf=not-time`, service)).toMatchObject({ status: 400, body: { code: 'ARCHIVE_TIME_INVALID' } });
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges raw and archived days, lets archives win, and isolates providers', async () => {
    const root = s6TempDir();
    try {
      const current = s6Paths(root);
      const otherScan = archivePath.join(root, 'other-provider');
      const archivedDate = S6_DATES[1];
      const rawDate = S6_DATES[2];
      s6WriteDay(current.scanDir, archivedDate);
      await archiveSession(current.scanDir, S6_PROVIDER, archivedDate, { archiveRoot: current.archiveRoot, keep: 30 });
      s6WriteDay(current.scanDir, archivedDate); // same date must still resolve to archive
      s6WriteDay(current.scanDir, rawDate);
      s6WriteDay(otherScan, S6_DATES[3]);
      await archiveSession(otherScan, 'other', S6_DATES[3], { archiveRoot: current.archiveRoot, keep: 30 });

      const days = await listReplayDays(current.scanDir, current.archiveRoot, S6_PROVIDER);
      expect(days).toEqual([
        expect.objectContaining({ date: rawDate, source: 'live', minutes: 3, futuresSymbols: ['ALPHA', 'BETA'] }),
        expect.objectContaining({ date: archivedDate, source: 'archive', minutes: 3, futuresSymbols: ['ALPHA', 'BETA'] }),
      ]);
      expect(days.some(day => day.date === S6_DATES[3])).toBe(false);
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds archive completion behind a capture-settlement gate', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      const source = s6WriteDay(scanDir, date);
      let releaseCapture;
      const captureSettled = new Promise(resolve => { releaseCapture = resolve; });
      const service = createArchiveService({
        scanDir,
        providerId: S6_PROVIDER,
        archiveRoot,
        beforeArchive: () => captureSettled.then(() => () => {}),
        logger: () => {},
      });
      const work = service.archive(date);
      await Promise.resolve();
      expect(archiveFs.existsSync(source.day)).toBe(true);
      releaseCapture();
      await work;
      expect(archiveFs.existsSync(source.day)).toBe(false);
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses retention deletion when a structurally valid gzip changes', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      for (const date of S6_DATES.slice(0, 2)) s6WriteDay(scanDir, date);
      await archiveSession(scanDir, S6_PROVIDER, S6_DATES[0], { archiveRoot, keep: 2 });
      await archiveSession(scanDir, S6_PROVIDER, S6_DATES[1], { archiveRoot, keep: 2 });
      const oldFile = archivePath.join(archiveRoot, S6_PROVIDER, `${S6_DATES[0]}.json.gz`);
      const payload = JSON.parse(gunzipSync(archiveFs.readFileSync(oldFile)).toString('utf8'));
      payload.minutes['0915'] = { ...payload.minutes['0915'], tampered: true };
      archiveFs.writeFileSync(oldFile, gzipSync(JSON.stringify(payload)));
      const third = s6WriteDay(scanDir, S6_DATES[2]);
      await expect(archiveSession(scanDir, S6_PROVIDER, S6_DATES[2], { archiveRoot, keep: 2 })).rejects.toMatchObject({ code: 'ARCHIVE_VERIFY_FAILED' });
      expect(archiveFs.existsSync(oldFile)).toBe(true);
      expect(archiveFs.existsSync(third.day)).toBe(true);
      expect(JSON.parse(archiveFs.readFileSync(archivePath.join(archiveRoot, 'index.json'), 'utf8')).map(entry => entry.date)).toEqual(S6_DATES.slice(0, 3));
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects archive reads whose payload identity differs from the requested provider/date', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, logger: () => {} });
      await service.archive(date);
      const file = archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`);
      const payload = JSON.parse(gunzipSync(archiveFs.readFileSync(file)).toString('utf8'));
      payload.providerId = 'other-provider';
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify(payload)));
      expect(await archiveRequestAsync('GET', `/api/archive/${date}/manifest`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_VERIFY_FAILED' } });
      payload.providerId = S6_PROVIDER;
      payload.date = S6_DATES[2];
      for (const future of Object.values(payload.futures)) future.session = S6_DATES[2];
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify(payload)));
      expect(await archiveRequestAsync('GET', `/api/archive/${date}/minute/0915`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_VERIFY_FAILED' } });
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects valid tampering of a non-first minute and futures record by fingerprint', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, logger: () => {} });
      await service.archive(date);
      const file = archivePath.join(archiveRoot, S6_PROVIDER, `${date}.json.gz`);
      const original = JSON.parse(gunzipSync(archiveFs.readFileSync(file)).toString('utf8'));
      const tamperedMinute = structuredClone(original);
      tamperedMinute.minutes['0916'] = { ...tamperedMinute.minutes['0916'], tampered: true };
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify(tamperedMinute)));
      expect(await archiveRequestAsync('GET', `/api/archive/${date}/minute/0916`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_VERIFY_FAILED' } });

      archiveFs.writeFileSync(file, gzipSync(JSON.stringify(original)));
      const tamperedFutures = structuredClone(original);
      tamperedFutures.futures.ALPHA.months[0].candles[1].close = 999;
      archiveFs.writeFileSync(file, gzipSync(JSON.stringify(tamperedFutures)));
      expect(await archiveRequestAsync('GET', `/api/archive/${date}/futures/ALPHA?asOf=0918`, service)).toMatchObject({ status: 503, body: { code: 'ARCHIVE_VERIFY_FAILED' } });
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to archived market and futures snapshots only when raw days are absent', async () => {
    const root = s6TempDir();
    try {
      const { scanDir, archiveRoot } = s6Paths(root);
      const date = S6_DATES[1];
      const source = s6WriteDay(scanDir, date);
      const service = createArchiveService({ scanDir, providerId: S6_PROVIDER, archiveRoot, logger: () => {} });
      await archiveSession(scanDir, S6_PROVIDER, date, { archiveRoot });

      const minute = await readArchiveMinuteFallback(scanDir, service, date, '0916');
      expect(minute).toEqual(source.minuteSnapshots['0916']);
      const futures = await readArchiveFuturesFallback(scanDir, service, date, 'ALPHA');
      expect(futures).toMatchObject({ symbol: 'ALPHA', session: date, months: source.futures.ALPHA.months });

      s6WriteDay(scanDir, date);
      expect(await readArchiveMinuteFallback(scanDir, service, date, '0916')).toBeNull();
      expect(await readArchiveFuturesFallback(scanDir, service, date, 'ALPHA')).toBeNull();
    } finally {
      archiveFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
