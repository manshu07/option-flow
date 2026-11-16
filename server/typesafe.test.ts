import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestText, triageDecisions, triageQuestions, runTriage } from './typesafe.mjs';
import { loadAlertRules, marketMovers, inFireWindow } from './alerts.mjs';

const ROW = (symbol, buildup = 'SHORT BUILD-UP') => ({ symbol, changePct: -3, spot: 100, oiAdded: 2_000_000, oiPct: 5, buildup });

function marketFixture() {
  const series = [
    { s: 'RISER', sp: 105, pc: 100, r: [[100, 0, 10, 10, 200_000, 100_000, 0, 0]] },
    { s: 'FALLER', sp: 95, pc: 100, r: [[100, 1, 10, 10, 150_000, 100_000, 0, 0]] },
    { s: 'FLAT', sp: 100, pc: 100, r: [[100, 0, 10, 10, 100_000, 100_000, 0, 0]] },
  ];
  return { date: '2026-11-16', t: Date.parse('2026-11-16T05:00:00Z'), series };
}

describe('inFireWindow', () => {
  it('gates the 09:30–15:00 IST window', () => {
    expect(inFireWindow(Date.parse('2026-11-16T04:17:00Z'))).toBe(true); // 09:47
    expect(inFireWindow(Date.parse('2026-11-16T09:30:00Z'))).toBe(true); // 15:00
    expect(inFireWindow(Date.parse('2026-11-16T03:50:00Z'))).toBe(false); // 09:20
    expect(inFireWindow(Date.parse('2026-11-16T09:31:00Z'))).toBe(false); // 15:01
  });
});

describe('marketMovers / digestText', () => {
  it('flags day-floor build-ups and renders them into the digest', () => {
    const market = marketFixture();
    const movers = marketMovers(market);
    const riser = movers.find(m => m.symbol === 'RISER');
    expect(riser.buildup).toBe('LONG BUILD-UP');
    expect(movers.find(m => m.symbol === 'FLAT')?.buildup).toBeNull();
    const digest = digestText(market, movers);
    expect(digest).toContain('RISER +5.00%');
    expect(digest).toContain('FALLER SHORT BUILD-UP');
    expect(digest).toContain('2026-11-16');
  });
});

describe('triageQuestions / triageDecisions', () => {
  const rows = [ROW('INOXWIND'), ROW('KAYNES')];

  it('asks one battery per flagged symbol plus the screen', () => {
    const questions = triageQuestions(rows);
    expect(Object.keys(questions)).toEqual(['worth_watching', 'watch_INOXWIND', 'bias_INOXWIND', 'watch_KAYNES', 'bias_KAYNES']);
  });

  it('routes by probability: ≥0.7 rule, 0.3–0.7 digest, ≤0.3 ignored', () => {
    const answers = {
      worth_watching: { noul: 0.91 },
      watch_INOXWIND: { noul: 0.82 },
      bias_INOXWIND: { choice: 'bearish' },
      watch_KAYNES: { noul: 0.42 },
      bias_KAYNES: { choice: 'bearish' },
    };
    const { watches, digestOnly } = triageDecisions(rows, answers);
    expect(watches).toHaveLength(1);
    expect(watches[0].symbol).toBe('INOXWIND');
    expect(digestOnly.map(d => d.symbol)).toEqual(['KAYNES']);
  });

  it('caps the watch list at the strongest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ROW(`SYM${i}`));
    const answers = { worth_watching: { noul: 0.99 } };
    for (let i = 0; i < 12; i++) answers[`watch_SYM${i}`] = { noul: 0.7 + i / 100 };
    const { watches } = triageDecisions(many, answers);
    expect(watches).toHaveLength(8);
    expect(watches[0].symbol).toBe('SYM11');
  });

  it('writes no rules when the screen says the digest is noise', () => {
    const { watches } = triageDecisions(rows, { worth_watching: { noul: 0.1 }, watch_INOXWIND: { noul: 0.95 } });
    expect(watches).toHaveLength(0);
  });
});

describe('loadAlertRules merge', () => {
  it('merges auto rules, with static file winning on symbol and id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-merge-'));
    try {
      const rulesPath = join(dir, 'alerts.json');
      writeFileSync(rulesPath, JSON.stringify({ rules: [
        { id: 'a', type: 'buildup', symbol: 'POLICYBZR', label: 'static' },
        { id: 'ts-watch-DUP', type: 'level', symbol: 'X' },
      ] }));
      writeFileSync(join(dir, 'alerts.auto.json'), JSON.stringify({ rules: [
        { id: 'ts-watch-TMPV', type: 'buildup', symbol: 'TMPV', auto: true },
        { id: 'ts-watch-POLICYBZR', type: 'buildup', symbol: 'POLICYBZR', auto: true },
        { id: 'ts-watch-DUP', type: 'buildup', symbol: 'DUP', auto: true },
        { id: 'u1', type: 'buildup', symbol: 'NOAUTO' },
      ] }));
      const merged = loadAlertRules(rulesPath);
      expect(merged.map(r => r.id)).toEqual(['a', 'ts-watch-DUP', 'ts-watch-TMPV']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to static rules when the auto file is missing or corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-merge-'));
    try {
      const rulesPath = join(dir, 'alerts.json');
      writeFileSync(rulesPath, JSON.stringify({ rules: [{ id: 'a', type: 'level', symbol: 'NIFTY' }] }));
      expect(loadAlertRules(rulesPath)).toHaveLength(1);
      writeFileSync(join(dir, 'alerts.auto.json'), '{ broken');
      expect(loadAlertRules(rulesPath)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runTriage gates', () => {
  const autoPath = join(tmpdir(), 'alerts.auto.json');

  it('never calls TypeSafe outside the fire window', async () => {
    const result = await runTriage(marketFixture(), {
      autoPath,
      now: Date.parse('2026-11-16T03:50:00Z'),
      ask: () => { throw new Error('must not be called'); },
    });
    expect(result.skipped).toBe('outside fire window');
  });

  it('skips without build-ups even inside the window', async () => {
    const market = { date: '2026-11-16', series: [{ s: 'FLAT', sp: 100, pc: 100, r: [[100, 0, 10, 10, 100_000, 100_000, 0, 0]] }] };
    const result = await runTriage(market, {
      autoPath,
      now: Date.parse('2026-11-16T04:17:00Z'),
      ask: () => { throw new Error('must not be called'); },
    });
    expect(result.skipped).toBe('no build-ups flagged');
  });

  it('surfaces a TypeSafe failure as a skip, keeping auto rules intact', async () => {
    const result = await runTriage(marketFixture(), {
      autoPath,
      now: Date.parse('2026-11-16T04:20:00Z'),
      ask: async () => { throw new Error('HTTP 503'); },
    });
    expect(result.skipped).toBe('failed');
  });
});
