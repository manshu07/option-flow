import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LAUNCHD_LABEL = 'com.order-flow.dev';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'scripts', `${LAUNCHD_LABEL}.plist`);
const TARGET = path.join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const LOG_DIR = path.join(ROOT, 'server', 'data', 'logs');
const LAUNCHCTL = '/bin/launchctl';

const escapeXml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})[char]);

export function renderLaunchAgent(template, { projectRoot, nodePath, npmCliPath, pathValue }) {
  const values = {
    ROOT: projectRoot,
    NODE: nodePath,
    NPM_CLI: npmCliPath,
    PATH: pathValue,
    LOG_DIR: path.join(projectRoot, 'server', 'data', 'logs'),
  };
  return template.replace(/__(ROOT|NODE|NPM_CLI|PATH|LOG_DIR)__/g, (token, key) => {
    if (!(key in values)) throw new Error(`Missing LaunchAgent template value for ${token}`);
    return escapeXml(values[key]);
  });
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync(LAUNCHCTL, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`launchctl ${args[0]} failed (${result.status ?? 'no status'})`);
  return result.status === 0;
}

function userDomain() {
  if (typeof process.getuid !== 'function') throw new Error('The Order Flow LaunchAgent is supported on macOS only.');
  return `gui/${process.getuid()}`;
}

function npmCliPath() {
  const candidate = process.env.npm_execpath;
  if (candidate && path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
  throw new Error('Run this command through npm: npm run service:install');
}

function install() {
  if (process.platform !== 'darwin') throw new Error('The Order Flow LaunchAgent is supported on macOS only.');
  const domain = userDomain();
  const labelTarget = `${domain}/${LAUNCHD_LABEL}`;
  const npmCli = npmCliPath();
  const template = readFileSync(TEMPLATE, 'utf8');
  const plist = renderLaunchAgent(template, {
    projectRoot: ROOT,
    nodePath: process.execPath,
    npmCliPath: npmCli,
    pathValue: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  });

  mkdirSync(path.dirname(TARGET), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const temp = `${TARGET}.tmp`;
  writeFileSync(temp, plist, { mode: 0o644 });
  renameSync(temp, TARGET);

  runLaunchctl(['bootout', domain, TARGET], { allowFailure: true });
  runLaunchctl(['enable', labelTarget]);
  runLaunchctl(['bootstrap', domain, TARGET]);
  console.log(`Installed ${LAUNCHD_LABEL}. Logs: ${LOG_DIR}`);
  console.log(`Kickstart with: launchctl kickstart -k ${labelTarget}`);
}

function uninstall() {
  if (process.platform !== 'darwin') throw new Error('The Order Flow LaunchAgent is supported on macOS only.');
  runLaunchctl(['bootout', userDomain(), TARGET], { allowFailure: true });
  try { unlinkSync(TARGET); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  console.log(`Uninstalled ${LAUNCHD_LABEL}. Logs and market data were left in place.`);
}

function main() {
  const command = process.argv[2];
  if (command === 'install') return install();
  if (command === 'uninstall') return uninstall();
  throw new Error('Usage: npm run service:install | npm run service:uninstall');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}
