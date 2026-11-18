import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlertDigestState, evaluateAlerts, flushScheduledDigests, runAlerts } from './alerts.mjs';
import { activeChatIds, loadSubscribers, pollCommands, saveSubscribers } from './subscribers.mjs';

const NOW = Date.parse('2026-11-16T04:17:00Z');
const tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'order-flow-subscribers-'));
  tempDirs.push(dir);
  return dir;
}

function telegramResponse(result: unknown[], status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: true, result }) };
}

function update(update_id: number, chatId: number, text: string) {
  return { update_id, message: { chat: { id: chatId }, text } };
}

function rulesFile(dir: string, rules: unknown[]) {
  const path = join(dir, 'alerts.json');
  writeFileSync(path, JSON.stringify({ rules }));
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Telegram subscribers', () => {
  it('/start subscribes idempotently and persists the update offset', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    let updates = [update(10, 123, '/START@orderflowbot')];
    const handle = vi.fn(async () => telegramResponse(updates));
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    const first = await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send });
    expect(first.offset).toBe(11);
    expect(loadSubscribers(statePath)).toEqual({
      subscribers: [{ chatId: 123, startedAt: NOW, active: true, alerts: [] }],
      offset: 11,
    });
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Educational only; not investment advice.'), { chatId: 123 });
    const requestUrl = new URL(handle.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('offset')).toBe('0');
    expect(requestUrl.searchParams.get('allowed_updates')).toBe('["message"]');

    updates = [update(11, 123, '/start')];
    const second = await pollCommands({ token: 'test-token', statePath, now: NOW + 1, handle, send });
    expect(second.offset).toBe(12);
    expect(loadSubscribers(statePath).subscribers).toHaveLength(1);
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining('Already subscribed'), { chatId: 123 });
  });

  it('/stop deactivates a subscriber and is a no-op for an unknown chat', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 123, startedAt: NOW - 1000, active: true }], offset: 5 });
    const handle = vi.fn(async () => telegramResponse([update(5, 123, '/stop'), update(6, 456, '/stop')]));
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    const result = await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send });

    expect(result.offset).toBe(7);
    expect(loadSubscribers(statePath)).toEqual({
      subscribers: [{ chatId: 123, startedAt: NOW - 1000, active: false, alerts: [] }],
      offset: 7,
    });
    expect(activeChatIds(loadSubscribers(statePath))).toEqual([]);
    expect(send).toHaveBeenNthCalledWith(1, expect.stringContaining('Subscription stopped'), { chatId: 123 });
    expect(send).toHaveBeenNthCalledWith(2, expect.stringContaining('not subscribed'), { chatId: 456 });
  });

  it('caps active subscribers at 500', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, {
      subscribers: Array.from({ length: 500 }, (_, index) => ({ chatId: index + 1, startedAt: NOW, active: true })),
      offset: 0,
    });
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle: async () => telegramResponse([update(1, 501, '/start')]), send });

    expect(loadSubscribers(statePath).subscribers).toHaveLength(500);
    expect(activeChatIds(loadSubscribers(statePath))).toHaveLength(500);
    expect(send).toHaveBeenCalledWith(expect.stringContaining('list is full'), { chatId: 501 });
  });

  it('does not advance the offset or reply when the state save fails', async () => {
    const dir = tempDir();
    const blockedParent = join(dir, 'not-a-directory');
    writeFileSync(blockedParent, 'file prevents the state directory');
    const statePath = join(blockedParent, 'subscribers.json');
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    const result = await pollCommands({
      token: 'test-token',
      statePath,
      now: NOW,
      handle: async () => telegramResponse([update(42, 123, '/start')]),
      send,
    });

    expect(result).toMatchObject({ offset: 0, skipped: 'save failed' });
    expect(loadSubscribers(statePath).offset).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('fans out one instant batch per subscriber and keeps private rules owner-only', async () => {
    const dir = tempDir();
    const rulesPath = rulesFile(dir, [
      { id: 'private-build', type: 'buildup', symbol: 'NIFTY', broadcast: false },
      { id: 'level', type: 'level', symbol: 'NIFTY', above: 100, label: 'NIFTY <zone>', broadcast: true },
    ]);
    const calls: Array<{ text: string; options?: { chatId?: number; parseMode?: string; retry?: boolean } }> = [];
    const send = vi.fn(async (text: string, options?: { chatId?: number; parseMode?: string; retry?: boolean }) => {
      calls.push({ text, options });
      return { sent: true };
    });
    const market = {
      date: '2026-11-16',
      series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [[100, 0, 10, 9, 2000, 1000, 0]] }],
    };

    const messages = await runAlerts(market, { rulesPath, state: new Map(), now: NOW, send, broadcastChatIds: [201, 202, 203] });

    expect(messages).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(calls[0].options).toEqual({ parseMode: 'HTML', retry: true });
    expect(calls[0].text).toContain('buy side');
    expect(calls[0].text).toContain('Level');
    expect(calls.slice(1).map(call => call.options?.chatId)).toEqual([201, 202, 203]);
    expect(calls.slice(1).every(call => call.options?.parseMode === 'HTML')).toBe(true);
    expect(calls.slice(1).every(call => call.text.includes('not investment advice'))).toBe(true);
    expect(calls.slice(1).every(call => !call.text.includes('LONG BUILD-UP'))).toBe(true);
  });

  it('sends one combined HTML message to the owner when there are no subscribers', async () => {
    const rulesPath = rulesFile(tempDir(), [
      { id: 'level', type: 'level', symbol: 'NIFTY', above: 100, label: 'NIFTY high', broadcast: true },
    ]);
    const send = vi.fn(async () => ({ sent: true }));
    const market = { date: '2026-11-16', series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [] }] };

    const messages = await runAlerts(market, { rulesPath, state: new Map(), now: NOW, send });

    expect(messages).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ parseMode: 'HTML', retry: true });
    const ownerText = send.mock.calls[0][0] as string;
    expect(ownerText).toContain('<b>Order Flow</b>');
    expect(ownerText).not.toContain('not investment advice');
  });

  it('escapes subscriber HTML labels while retaining bold headlines', async () => {
    const rulesPath = rulesFile(tempDir(), [
      { id: 'level', type: 'level', symbol: 'NIFTY', above: 100, label: 'NIFTY <100 & high>', broadcast: true },
    ]);
    const send = vi.fn(async () => ({ sent: true }));
    const market = { date: '2026-11-16', series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [] }] };

    await runAlerts(market, { rulesPath, state: new Map(), now: NOW, send, broadcastChatIds: [123] });

    const subscriberText = send.mock.calls[1][0] as string;
    expect(subscriberText).toContain('<b>NIFTY &lt;100 &amp; high&gt;</b>');
    expect(subscriberText).not.toContain('<100 & high>');
  });

  it('does not throw when Telegram polling rejects with a 502 error', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    const log = vi.fn();

    const result = await pollCommands({
      token: 'test-token',
      statePath,
      now: NOW,
      handle: vi.fn().mockRejectedValue(new Error('upstream 502')),
      log,
    });

    expect(result).toMatchObject({ offset: 0, skipped: 'poll failed' });
    expect(loadSubscribers(statePath).offset).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('upstream 502'));
  });

  it('escalates cooldowns from 10 to 30 to 60 minutes and caps at six fires per day', () => {
    const state = new Map();
    const rules = [{ id: 'level', type: 'level', symbol: 'NIFTY', below: 200 }];
    const marketFor = (date = '2026-11-16') => ({ date, series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [] }] });
    const fireAt = (minutes: number, date?: string) => evaluateAlerts(marketFor(date), rules, state, NOW + minutes * 60_000);

    expect(fireAt(0)).toHaveLength(1);
    expect(fireAt(9)).toHaveLength(0);
    expect(fireAt(10)).toHaveLength(1);
    expect(state.get('level')).toMatchObject({ firesToday: 2, step: 1 });
    expect(fireAt(39)).toHaveLength(0);
    expect(fireAt(40)).toHaveLength(1);
    expect(state.get('level')).toMatchObject({ firesToday: 3, step: 2 });
    expect(fireAt(99)).toHaveLength(0);
    expect(fireAt(100)).toHaveLength(1);
    expect(fireAt(160)).toHaveLength(1);
    expect(fireAt(220)).toHaveLength(1);
    expect(state.get('level')).toMatchObject({ firesToday: 6, step: 2 });
    expect(fireAt(280)).toHaveLength(0);
    expect(fireAt(0, '2026-11-17')).toHaveLength(1);
    expect(state.get('level')).toMatchObject({ dayKey: '2026-11-17', firesToday: 1, step: 0 });
  });

  it('batches one evaluation into fixed-order HTML sections and skips empty sections', async () => {
    const rulesPath = rulesFile(tempDir(), [
      { id: 'oi', type: 'oi-spike', symbol: 'NIFTY', oiChangePctMin: 30, oiMin: 1000, label: 'NIFTY OI spikes' },
      { id: 'build', type: 'buildup', symbol: 'NIFTY' },
      { id: 'level', type: 'level', symbol: 'NIFTY', above: 100, label: 'NIFTY level' },
    ]);
    const send = vi.fn(async () => ({ sent: true }));
    const market = {
      date: '2026-11-16',
      series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [[25_250, 1, 2, 1, 2_000, 1_000, 0]] }],
    };

    const messages = await runAlerts(market, { rulesPath, state: new Map(), now: NOW, send });

    expect(messages).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][0] as string;
    const level = body.indexOf('🚨 <b>Level</b>');
    const build = body.indexOf('📈 <b>Build-ups</b>');
    const oi = body.indexOf('⚡ <b>OI spikes</b>');
    expect(level).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(level);
    expect(oi).toBeGreaterThan(build);
    expect(body).not.toContain('<b>Digest</b>');
    expect(body.length).toBeLessThan(900);
  });

  it('queues subscriber build-ups for the next digest while sending NIFTY levels instantly', async () => {
    const rulesPath = rulesFile(tempDir(), [
      { id: 'level', type: 'level', symbol: 'NIFTY', above: 100, label: 'NIFTY level', broadcast: true },
      { id: 'build', type: 'buildup', symbol: 'NIFTY', broadcast: true },
    ]);
    const send = vi.fn(async () => ({ sent: true }));
    const digestState = createAlertDigestState();
    const market = {
      date: '2026-11-16',
      series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [[25_250, 1, 2, 1, 2_000_000, 1_000_000, 0]] }],
    };

    await runAlerts(market, {
      rulesPath,
      state: new Map(),
      digestState,
      now: Date.parse('2026-11-16T05:00:00Z'),
      send,
      broadcastChatIds: [777],
    });
    expect(send).toHaveBeenCalledTimes(2); // owner batch + subscriber's instant level
    expect(send.mock.calls[1][0]).toContain('<b>Level</b>');
    expect(send.mock.calls[1][0]).not.toContain('<b>Build-ups</b>');
    expect(digestState.pending.size).toBe(1);

    const digestAt = Date.parse('2026-11-16T10:15:00Z'); // 15:45 IST
    await flushScheduledDigests({ digestState, now: digestAt, broadcastChatIds: [777], send });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toContain('<b>Build-ups</b>');
    expect(send.mock.calls[2][0]).not.toContain('<b>Level</b>');
    expect(digestState.pending.size).toBe(0);
    await flushScheduledDigests({ digestState, now: digestAt, broadcastChatIds: [777], send });
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe('/live command dispatch', () => {
  it('routes active subscribers and the owner through the same cached-data handler', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 321, startedAt: NOW, active: true }], offset: 0 });
    const handleLive = vi.fn(async (symbol: string, side: string | null) => `<b>${symbol} ${side ?? 'both'}</b> · educational only; not investment advice.`);
    const send = vi.fn(async (_text: string) => ({ sent: true }));
    const handle = vi.fn(async () => telegramResponse([update(1, 321, '/LIVE NIFTY PE'), update(2, 999, '/live BANKNIFTY') ]));

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send, ownerChatId: '999', handleLive });

    expect(handleLive).toHaveBeenNthCalledWith(1, 'NIFTY', 'PE');
    expect(handleLive).toHaveBeenNthCalledWith(2, 'BANKNIFTY', null);
    expect(send).toHaveBeenNthCalledWith(1, expect.stringContaining('<b>NIFTY PE</b>'), { chatId: 321, parseMode: 'HTML' });
    expect(send).toHaveBeenNthCalledWith(2, expect.stringContaining('<b>BANKNIFTY both</b>'), { chatId: 999, parseMode: 'HTML' });
    expect(send.mock.calls.every(([text]) => String(text).includes('not investment advice'))).toBe(true);
  });

  it('limits each chat to five live requests per ten minutes', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 891, startedAt: NOW, active: true }], offset: 0 });
    const updates = Array.from({ length: 6 }, (_, index) => update(index + 1, 891, '/live TMPV'));
    const handleLive = vi.fn(async () => '📡 TMPV · not investment advice');
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle: async () => telegramResponse(updates), send, handleLive });

    expect(handleLive).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send.mock.calls[5][0]).toContain('5 requests per 10 minutes');
    expect(send.mock.calls[5][0]).toContain('not investment advice');

    await pollCommands({
      token: 'test-token',
      statePath,
      now: NOW + 10 * 60_000,
      handle: async () => telegramResponse([update(7, 891, '/live TMPV')]),
      send,
      handleLive,
    });
    expect(handleLive).toHaveBeenCalledTimes(6);
  });
});

describe('/journal command dispatch', () => {
  it('routes the journal reply only to an active subscriber or the owner', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 651, startedAt: NOW, active: true }], offset: 0 });
    const handleJournal = vi.fn(async () => '<b>Journal · not investment advice</b>');
    const send = vi.fn(async (_text: string) => ({ sent: true }));
    const handle = async () => telegramResponse([update(1, 651, '/journal'), update(2, 999, '/journal')]);

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send, ownerChatId: '999', handleJournal });

    expect(handleJournal).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, '<b>Journal · not investment advice</b>', { chatId: 651, parseMode: 'HTML' });
    expect(send).toHaveBeenNthCalledWith(2, '<b>Journal · not investment advice</b>', { chatId: 999, parseMode: 'HTML' });
  });

  it('denies inactive chats without reading the journal and keeps the disclaimer', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    const handleJournal = vi.fn(async () => 'should not be read');
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    await pollCommands({
      token: 'test-token',
      statePath,
      now: NOW,
      handle: async () => telegramResponse([update(1, 652, '/journal')]),
      send,
      ownerChatId: '999',
      handleJournal,
    });

    expect(handleJournal).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toContain('Use /start');
    expect(send.mock.calls[0][0]).toContain('not investment advice');
  });

  it('routes /obs and /oi through injected handlers with rate limits', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 661, startedAt: NOW, active: true }], offset: 0 });
    const handleObs = vi.fn(async () => '<b>TMPV 265PE</b> · entry ₹5.95');
    const handleOi = vi.fn(async () => 'CE walls: 300 (11.8M)');
    const send = vi.fn(async (_text: string) => ({ sent: true }));
    const handle = async () => telegramResponse([
      update(1, 661, '/obs TMPV'),
      update(2, 661, '/oi TMPV 265'),
      update(3, 662, '/obs TMPV'),
      update(4, 661, '/bogus'),
    ]);

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send, ownerChatId: '999', handleObs, handleOi, isKnownSymbol: () => true });

    expect(handleObs).toHaveBeenCalledTimes(1); // chat 662 is not subscribed → denied
    expect(handleObs).toHaveBeenCalledWith('TMPV');
    expect(handleOi).toHaveBeenNthCalledWith(1, 'TMPV', 265);
    expect(send).toHaveBeenNthCalledWith(1, '<b>TMPV 265PE</b> · entry ₹5.95', { chatId: 661, parseMode: 'HTML' });
    expect(send).toHaveBeenNthCalledWith(2, 'CE walls: 300 (11.8M)', { chatId: 661, parseMode: 'HTML' });
    expect(send.mock.calls.at(-1)[0]).toContain('Unknown command');
  });

  it('watches and unwatches symbols as personal buildup rules', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 671, startedAt: NOW, active: true }], offset: 0 });
    const send = vi.fn(async (_text: string) => ({ sent: true }));
    const handle = async () => telegramResponse([update(1, 671, '/watch TMPV'), update(2, 671, '/watch'), update(3, 671, '/unwatch TMPV'), update(4, 671, '/watch')]);

    await pollCommands({ token: 'test-token', statePath, now: NOW, handle, send, isKnownSymbol: () => true });

    const afterWatch = loadSubscribers(statePath);
    // /unwatch already applied by the end of the pass; verify via reply sequence instead.
    expect(send.mock.calls[0][0]).toContain('Now watching <b>TMPV</b>');
    expect(send.mock.calls[1][0]).toContain('Watching: TMPV');
    expect(send.mock.calls[2][0]).toContain('Stopped watching TMPV');
    expect(send.mock.calls[3][0]).toContain('Not watching any symbol');
    expect(afterWatch.subscribers[0].alerts).toHaveLength(0);
  });
});

describe('personal subscriber alerts', () => {
  it('creates, lists, and removes a persisted threshold alert by id', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, { subscribers: [{ chatId: 701, startedAt: NOW, active: true }], offset: 0 });
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    await pollCommands({
      token: 'test-token', statePath, now: NOW, send, isKnownSymbol: symbol => symbol === 'NIFTY',
      handle: async () => telegramResponse([update(1, 701, '/alert nifty above 25246')]),
    });
    const created = loadSubscribers(statePath).subscribers[0].alerts[0];
    expect(created).toMatchObject({ symbol: 'NIFTY', direction: 'above', level: 25246, createdAt: NOW });
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining(`Personal alert <b>${created.id}</b> set`), { chatId: 701, parseMode: 'HTML' });

    await pollCommands({
      token: 'test-token', statePath, now: NOW + 1, send, isKnownSymbol: symbol => symbol === 'NIFTY',
      handle: async () => telegramResponse([update(2, 701, '/alerts')]),
    });
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining(`${created.id}</b> NIFTY above 25246`), { chatId: 701, parseMode: 'HTML' });

    await pollCommands({
      token: 'test-token', statePath, now: NOW + 2, send, isKnownSymbol: symbol => symbol === 'NIFTY',
      handle: async () => telegramResponse([update(3, 701, `/unalert ${created.id}`)]),
    });
    expect(loadSubscribers(statePath).subscribers[0].alerts).toEqual([]);
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining('removed'), { chatId: 701, parseMode: 'HTML' });
  });

  it('enforces the ten-rule cap and rejects unknown symbols', async () => {
    const statePath = join(tempDir(), 'subscribers.json');
    saveSubscribers(statePath, {
      subscribers: [
        { chatId: 702, startedAt: NOW, active: true, alerts: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, symbol: 'NIFTY', direction: 'above', level: 100 + i, createdAt: NOW })) },
        { chatId: 703, startedAt: NOW, active: true },
      ],
      offset: 0,
    });
    const send = vi.fn(async (_text: string) => ({ sent: true }));

    await pollCommands({
      token: 'test-token', statePath, now: NOW, send, isKnownSymbol: symbol => symbol === 'NIFTY',
      handle: async () => telegramResponse([update(1, 702, '/alert NIFTY below 90'), update(2, 703, '/alert UNKNOWN above 10')]),
    });

    expect(loadSubscribers(statePath).subscribers[0].alerts).toHaveLength(10);
    expect(send).toHaveBeenNthCalledWith(1, expect.stringContaining('limit reached (10)'), { chatId: 702 });
    expect(send).toHaveBeenNthCalledWith(2, expect.stringContaining('unknown or unsupported'), { chatId: 703, parseMode: 'HTML' });
    expect(send.mock.calls.every(([text]) => String(text).includes('not investment advice'))).toBe(true);
  });

  it('evaluates personal thresholds through the shared engine with a five-fire daily cap', async () => {
    const rulesPath = rulesFile(tempDir(), []);
    const digestState = createAlertDigestState();
    const calls: Array<{ text: string; options?: { chatId: number; parseMode: string; retry: boolean } }> = [];
    const send = vi.fn(async (text: string, options?: { chatId: number; parseMode: string; retry: boolean }) => {
      calls.push({ text, options });
      return { sent: true };
    });
    const market = { date: '2026-11-16', series: [{ s: 'NIFTY', sp: 101, pc: 100, r: [] }] };
    const subscriberEntries = [{ chatId: 704, active: true, alerts: [{ id: 'a1', symbol: 'NIFTY', direction: 'above', level: 100 }] }];

    for (const minutes of [0, 10, 40, 100, 160, 220]) {
      await runAlerts(market, {
        rulesPath,
        state: new Map(),
        digestState,
        now: NOW + minutes * 60_000,
        send,
        subscriberEntries,
      });
    }

    expect(calls).toHaveLength(5);
    expect(calls.every(call => call.options?.chatId === 704 && call.options.parseMode === 'HTML')).toBe(true);
    expect(calls.every(call => call.text.includes('NIFTY above 100') && call.text.includes('not investment advice'))).toBe(true);
  });
});
