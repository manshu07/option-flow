/** `npm run dev`: the API (server/index.mjs) and Vite together; Vite proxies data to the API. */
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
// `npm run dev:recorded` replays a recorded real session instead of the demo market.
const api = run(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs', ...process.argv.slice(2)]);
// VITE_PORT lets a second dev tree run beside the live one (default: Vite's own 5195).
const webArgs = ['vite'];
if (process.env.VITE_PORT) webArgs.push('--host', '127.0.0.1', '--port', process.env.VITE_PORT);
const web = run(process.platform === 'win32' ? 'npx.cmd' : 'npx', webArgs);
const stop = () => { api.kill(); web.kill(); process.exit(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', code => { if (code) { console.error(`API exited (${code})`); web.kill(); process.exit(code); } });
web.on('exit', code => { api.kill(); process.exit(code ?? 0); });
