import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, renderLaunchAgent } from '../scripts/launchd-service.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'scripts', `${LAUNCHD_LABEL}.plist`), 'utf8');

describe('Order Flow LaunchAgent template', () => {
  it('renders a restartable Dhan service with per-user paths and logs', () => {
    const rendered = renderLaunchAgent(template, {
      projectRoot: '/Users/example/Order Flow & Charts',
      nodePath: '/Users/example/.nvm/bin/node',
      npmCliPath: '/Users/example/.nvm/npm-cli.js',
      pathValue: '/usr/bin:/bin:/Users/example/.nvm/bin',
    });

    expect(rendered).toContain('<string>com.order-flow.dev</string>');
    expect(rendered).toContain('<string>/Users/example/Order Flow &amp; Charts</string>');
    expect(rendered).toContain('<string>/Users/example/.nvm/bin/node</string>');
    expect(rendered).toContain('<string>/Users/example/.nvm/npm-cli.js</string>');
    expect(rendered).toContain('<key>MF_PROVIDER</key>');
    expect(rendered).toContain('<string>dhan</string>');
    expect(rendered).toContain('<key>KeepAlive</key>');
    expect(rendered).toContain('<key>ThrottleInterval</key>\n\t<integer>30</integer>');
    expect(rendered).toContain('/Users/example/Order Flow &amp; Charts/server/data/logs/order-flow.launchd.out.log');
    expect(rendered).toContain('/Users/example/Order Flow &amp; Charts/server/data/logs/order-flow.launchd.err.log');
    expect(rendered).not.toMatch(/__(?:ROOT|NODE|NPM_CLI|PATH|LOG_DIR)__/);
  });
});
