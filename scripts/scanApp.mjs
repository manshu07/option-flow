// scanApp — fast-anything profile target: boots an ISOLATED order-flow instance on port 8799
// (own data dir), lets it boot + build + settle for 5 minutes, then exits so the scan completes.
// The live 8787 service is never touched.
import { spawn } from 'node:child_process';

const child = spawn('node', ['--max-old-space-size=4096', 'server/index.mjs'], {
  env: { ...process.env, PORT: '8799', MF_DATA_DIR: '/tmp/of-scan-data' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const t = setTimeout(() => { child.kill('SIGTERM'); }, 300_000);
child.on('exit', () => { clearTimeout(t); process.exit(0); });
