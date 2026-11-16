import { describe, expect, it, vi } from 'vitest';
import { createAlertDigestState, evaluateAlerts, flushScheduledDigests } from './alerts.mjs';

const NOW = Date.parse('2026-11-16T04:17:00Z'); // 09:47 IST
const MINUTE = 60_000;

function market(rows: number[][], spot = 25_048, prevClose = 25_144): unknown {
  return {
    date: '2026-11-16',
    series: [{ s: 'NIFTY', k: 'index', e: '2026-11-26', t: NOW, sp: spot, pc: prevClose, r: rows }],
  };
}

const rows: number[][] = [
  [25_100, 1, 90, 80, 1_400_000, 900_000, 50_000], // PE OI day +55%
  [25_200, 0, 120, 110, 700_000, 650_000, 30_000], // CE OI day +7%
  [24_800, 0, 15, 14, 20_000, 19_000, 5_000], // dust strike
];

const rules = [
  { id: 'nifty-level', type: 'level', symbol: 'NIFTY', below: 25_054, above: 25_246, label: 'NIFTY level' },
  { id: 'nifty-buildup', type: 'buildup', symbol: 'NIFTY', label: 'NIFTY' },
  { id: 'nifty-oi-spike', type: 'oi-spike', symbol: 'NIFTY', oiChangePctMin: 30, oiMin: 500_000, top: 3, label: 'NIFTY OI spikes' },
];

describe('evaluateAlerts', () => {
  it('fires level and oi-spike alerts; buildup needs the day price floor', () => {
    const state = new Map();
    // Spot 25048 vs prev 25144 = −0.38%: under the 0.5% day price floor, so
    // the board's own semantics correctly hold the build-up back.
    const messages = evaluateAlerts(market(rows), rules, state, NOW);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('NIFTY level');
    expect(messages[0]).toContain('25048');
    expect(messages[1]).toContain('25100PE +56%'); // (1.4M − 0.9M) / 0.9M, rounded
  });

  it('holds the 10-minute cooldown for level, and fires again after it passes', () => {
    const state = new Map();
    evaluateAlerts(market(rows), rules, state, NOW);
    expect(evaluateAlerts(market(rows), rules, state, NOW + 5 * MINUTE)).toHaveLength(0); // level + oi-spike both held
    const later = evaluateAlerts(market(rows), rules, state, NOW + 11 * MINUTE);
    expect(later).toHaveLength(1); // the level again; oi-spike stays once-per-day
    expect(later[0]).toContain('NIFTY level');
  });

  it('fires the oi-spike once per session date even across cooldown windows', () => {
    const state = new Map();
    evaluateAlerts(market(rows), rules, state, NOW);
    const second = evaluateAlerts(market(rows), rules, state, NOW + 20 * MINUTE);
    expect(second.every(text => !text.includes('OI spikes'))).toBe(true);
  });

  it('stays silent when moves are inside the noise floors', () => {
    const quietRows: number[][] = [[25_100, 1, 90, 89, 1_005_000, 1_000_000, 50_000]];
    const state = new Map();
    const messages = evaluateAlerts(market(quietRows, 25_148, 25_144), rules, state, NOW);
    expect(messages).toHaveLength(0);
  });

  it('builds a top-movers digest ranked by day change with chain OI added', () => {
    const state = new Map();
    const moversMarket = {
      date: '2026-11-16',
      series: [
        { s: 'POWERINDIA', sp: 33_500, pc: 29_900, r: [[1, 0, 100, 90, 2_200_000, 200_000, 1]] },
        { s: 'MANAPPURAM', sp: 304, pc: 307.25, r: [[1, 1, 100, 90, 3_600_000, 3_000_000, 1]] },
        { s: 'SONACOMS', sp: 918, pc: 919, r: [[1, 0, 100, 90, 100_000, 100_000, 1]] },
      ],
    };
    const messages = evaluateAlerts(moversMarket, [{ id: 'digest', type: 'top-movers', top: 2, cooldownMin: 30 }], state, NOW);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('TOP MOVERS');
    expect(messages[0]).toContain('POWERINDIA +12.04%');
    expect(messages[0]).toContain('MANAPPURAM -1.06%');
    // repeat within the 30-minute cooldown stays silent
    expect(evaluateAlerts(moversMarket, [{ id: 'digest', type: 'top-movers', top: 2, cooldownMin: 30 }], state, NOW + 5 * MINUTE)).toHaveLength(0);
  });

  it('fires only inside the 09:30-15:00 IST alert window', () => {
    const state = new Map();
    // 07:30 IST — before the window
    expect(evaluateAlerts(market(rows), rules, state, Date.parse('2026-11-16T02:00:00Z'))).toHaveLength(0);
    // 15:45 IST — after the last fire
    expect(evaluateAlerts(market(rows), rules, state, Date.parse('2026-11-16T10:15:00Z'))).toHaveLength(0);
    // 09:47 IST — inside
    expect(evaluateAlerts(market(rows), rules, state, Date.parse('2026-11-16T04:17:00Z')).length).toBeGreaterThan(0);
  });

  it('skips rules for symbols the market file does not carry', () => {
    const state = new Map();
    const messages = evaluateAlerts(market(rows), [{ id: 'x', type: 'level', symbol: 'BANKNIFTY', below: 50_000 }], state, NOW);
    expect(messages).toHaveLength(0);
  });
});

describe('15:45 subscriber EOD report', () => {
  const close = Date.parse('2026-11-16T10:15:00Z'); // 15:45 IST

  it('combines daily movers, build-ups, levels, journal outcomes, and numeric tally', async () => {
    const digestState = createAlertDigestState();
    digestState.dayKey = '2026-11-16';
    digestState.dailyEvents.set('top-movers:movers', {
      rule: { id: 'movers', type: 'top-movers' },
      items: ['• 1. <b>POWERINDIA</b> +12.04% OI+2.0M'],
    });
    digestState.dailyEvents.set('buildup:tmpv', {
      rule: { id: 'tmpv', type: 'buildup' },
      items: ['• <b>TMPV</b> +5.16% · OI +2.9M · long'],
    });
    digestState.dailyEvents.set('level:nifty', {
      rule: { id: 'nifty', type: 'level' },
      items: ['• <b>NIFTY above Friday high</b> spot 25246'],
    });
    const observations = [
      { date: '2026-11-16', symbol: 'TMPV', strike: 265, side: 'PE', quality: 0.99, outcome: { status: 'tgt1', r: 1.22 } },
      { date: '2026-11-16', symbol: 'BANKNIFTY', strike: 61600, side: 'CE', quality: 0.88, outcome: { status: 'sl', r: -1 } },
      { date: '2026-11-16', symbol: 'SONACOMS', strike: 920, side: 'CE', quality: 0.91 },
    ];
    const send = vi.fn(async (_text: string, _options?: { chatId: number; parseMode: string; retry: boolean }) => ({ sent: true }));

    const result = await flushScheduledDigests({ digestState, now: close, broadcastChatIds: [456], observations, send });

    expect(result).toMatchObject({ sent: 1, messages: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const [message, options] = send.mock.calls[0];
    expect(options).toMatchObject({ chatId: 456, parseMode: 'HTML', retry: true });
    expect(message).toContain('<b>Top movers</b>');
    expect(message).toContain('<b>Build-ups</b>');
    expect(message).toContain('<b>Levels touched</b>');
    expect(message).toContain('<b>Journal outcomes</b>');
    expect(message).toContain('Cards written 3 · 1 TGT1 · 1 SL · 0 open · 0 ambiguous');
    expect(message).toContain('<b>Jev tally</b>');
    expect(message).toContain('not investment advice');
    expect(message).not.toContain('0.99');
    expect(message.length).toBeLessThan(900);
  });

  it('splits a long EOD report into report and journal messages under 900 chars', async () => {
    const digestState = createAlertDigestState();
    digestState.dayKey = '2026-11-16';
    for (let index = 0; index < 12; index++) {
      const id = `build-${index}`;
      digestState.dailyEvents.set(`buildup:${id}`, {
        rule: { id, type: 'buildup' },
        items: [`• <b>${'SYMBOL'.repeat(5)}${index}</b> +5.16% · OI +2.9M · long`],
      });
    }
    const observations = Array.from({ length: 30 }, (_, index) => ({
      date: '2026-11-16',
      symbol: `OBSERVATION${index}`,
      strike: 100 + index,
      side: 'CE',
      outcome: { status: index % 2 ? 'sl' : 'tgt1', r: index % 2 ? -1 : 1.22 },
    }));
    const sent: string[] = [];
    const send = vi.fn(async (text: string) => { sent.push(text); return { sent: true }; });

    const result = await flushScheduledDigests({ digestState, now: close, broadcastChatIds: [457], observations, send });

    expect(result).toMatchObject({ sent: 2, messages: 2 });
    expect(sent).toHaveLength(2);
    expect(sent.every(text => text.length < 900 && text.includes('not investment advice'))).toBe(true);
    expect(sent[0]).toContain('<b>Build-ups</b>');
    expect(sent[1]).toContain('<b>Journal outcomes</b>');
  });
});
