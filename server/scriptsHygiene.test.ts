// scriptsHygiene — STRUCTURAL GUARD (owner rule 2026-11-24: "ye blocking ka issue to kabhi
// ana hi nahi chahiye"): offline scripts in scripts/ must NEVER open the Dhan WebSocket feed.
// On 2026-11-24 an offline backfill script called provider.init(), which opened the full
// 5-connection feed and stole the live server's slots (market-hours outage, 0/5 for ~30 min).
//
// Rule: a script under scripts/ may reference the WS feed ONLY if it carries the explicit
// architect marker `// ws-allow:` on its own line (record-session.mjs: recording IS its
// purpose). Everything else must go through server/dhanRest.mjs (REST-only).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const scriptsDir = path.resolve(__dirname, '..', 'scripts');
const FORBIDDEN = [
  /createDhanProvider\s*\(/,
  /provider\.init\s*\(/,
  /api-feed\.dhan\.co/,
  /new\s+WebSocket\s*\(/,
  /from\s+['"]ws['"]/,
];

describe('scripts hygiene: offline scripts never open the Dhan WS feed', () => {
  it('no script touches the WS feed without an explicit // ws-allow: marker', () => {
    const violations: string[] = [];
    for (const file of readdirSync(scriptsDir)) {
      if (!file.endsWith('.mjs') && !file.endsWith('.ts')) continue;
      const text = readFileSync(path.join(scriptsDir, file), 'utf8');
      if (text.includes('// ws-allow:')) continue; // architect-approved exception
      const codeLines = text.split('\n').filter(l => !l.trim().startsWith('//'));
      const code = codeLines.join('\n');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(code)) violations.push(`${file}: matches ${pattern}`);
      }
    }
    expect(violations, `WS-feed usage found in offline scripts:\n${violations.join('\n')}`).toEqual([]);
  });
});
