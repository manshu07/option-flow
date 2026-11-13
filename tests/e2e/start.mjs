import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const DATE = '2026-10-30';
const recordedDir = process.env.MF_RECORDED_DIR || path.join(root, 'data', 'recorded');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-flow-playwright-'));
const safeEnv = new Set(['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'SYSTEMROOT', 'SystemRoot', 'WINDIR']);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => safeEnv.has(key))),
  MF_PROVIDER: 'recorded',
  MF_RECORDED_DIR: recordedDir,
  MF_RECORDED_DATE: DATE,
  MF_DATA_DIR: dataDir,
  HOST: '127.0.0.1',
  PORT: '8787',
};
const run = args => spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });

const epoch = hhmm => Date.parse(`${DATE}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00+05:30`);
const snapshot = (hhmm, close) => {
  const at = epoch(hhmm);
  return {
    schema: 1,
    t: at,
    date: DATE,
    series: [{
      s: 'RELIANCE', k: 'stock', e: '2026-11-24', lot: 500, ls: 'catalogue',
      t: at, tp: at, sp: close, pc: 995, atm: 1000,
      r: [[1000, 0, 10, 9, 5000, 4900, 100, 90, 10, null, 9.9, 10.1, 10, 10, 12, 8, at, null]],
      ks: [1000], z: [],
    }],
    minutes: [['1445', epoch('1445')], ['1447', epoch('1447')]],
    ladders: { RELIANCE: ['2026-11-24'] },
  };
};

function seedReplayFiles() {
  const sessionDir = path.join(dataDir, 'recorded', DATE);
  fs.mkdirSync(sessionDir, { recursive: true });
  const minutes = [['1445', epoch('1445')], ['1447', epoch('1447')]];
  fs.writeFileSync(path.join(sessionDir, 'index.json'), JSON.stringify(minutes));
  fs.writeFileSync(path.join(sessionDir, '1445.json'), JSON.stringify(snapshot('1445', 1045)));
  fs.writeFileSync(path.join(sessionDir, '1447.json'), JSON.stringify(snapshot('1447', 1047)));
}

async function waitForApi() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/status');
      const status = response.ok ? await response.json() : null;
      if (status?.ready && status.market) return;
    } catch { /* API is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Recorded E2E API did not become ready.');
}

seedReplayFiles();
const api = run(['server/index.mjs', '--recorded']);
let web = null;
let stopping = false;

const terminate = child => {
  if (!child) return Promise.resolve();
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000);
    timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
};

const stop = async code => {
  if (stopping) return;
  stopping = true;
  await Promise.all([terminate(api), terminate(web)]);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
};

process.on('SIGINT', () => { void stop(130); });
process.on('SIGTERM', () => { void stop(143); });
api.on('error', () => { void stop(1); });
api.on('exit', (code, signal) => { if (!stopping) void stop(code ?? (signal ? 1 : 0)); });

try {
  await waitForApi();
  // The recorded provider performs its initial live build on startup. Restore
  // the deterministic replay index before Vite becomes available to Playwright.
  seedReplayFiles();
  web = run(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5195', '--strictPort']);
  web.on('error', () => { void stop(1); });
  web.on('exit', (code, signal) => { if (!stopping) void stop(code ?? (signal ? 1 : 0)); });
} catch (error) {
  console.error(error);
  await stop(1);
}
