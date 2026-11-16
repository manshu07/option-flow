import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTelegram, sendTelegramObservationCard } from './telegram.mjs';
import { observationCaption } from './observationCardSvg.mjs';

const card = {
  symbol: 'NIFTY', date: '2026-11-16', strike: 25_150, side: 'CE', bias: 'bullish',
  spot: 25_291.15, spotChangePct: 0.58,
  expiry: '2026-11-19', entry: 1_003.30, sl: 551.81, tgt1: 1_555.11, tgt2: 1_906.27,
  quality: 0.82, strikePickProbability: 0.74, disclaimer: 'Educational observation; not trade advice.',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sendTelegramObservationCard', () => {
  it('sends a protected HTML Observation message with live values', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', '12345');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendTelegramObservationCard({
      ...card,
      sentAt: Date.parse('2026-11-16T04:22:00Z'),
      live: { spot: 25_291.15, future: 25_300, option: 1_064 },
    });

    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(init.method).toBe('POST');
    const payload = JSON.parse(String(init.body));
    expect(payload).toMatchObject({
      chat_id: '12345',
      parse_mode: 'HTML',
      protect_content: true,
    });
    expect(payload.text).toContain('🔍 <b>OBSERVATION</b> · NIFTY 25150CE · 09:52 IST');
    expect(payload.text).toContain('Bias: <b>bullish</b> · quality <b>82%</b> · strike pick 74%');
    expect(payload.text).toContain('<b>Trade map</b> (premium)');
    expect(payload.text).toContain('• Entry ~<b>1003.30</b> · spot 25291.15 (+0.6%)');
    expect(payload.text).toContain('<b>Chain walls</b>');
    expect(payload.text).toContain('<b>Live</b> · spot 25291.15 · fut 25300.00 · opt ₹1064.00 (▲ +6% vs entry)');
    expect(payload.text).toContain('captured-data observation · not advice · final call yours');
  });

  it('does not send if Telegram is not configured', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_CHAT_ID', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTelegramObservationCard(card)).resolves.toEqual({ sent: false, reason: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendTelegram', () => {
  it('retries one 429 response and protects subscriber HTML messages', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', '');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ parameters: { retry_after: 0 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTelegram('<b>alert</b>', { chatId: 678, parseMode: 'HTML' })).resolves.toEqual({ sent: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: 678,
      text: '<b>alert</b>',
      protect_content: true,
      parse_mode: 'HTML',
    });
  });
});

describe('Observation HTML design', () => {
  it('escapes dynamic fields and omits a quiet live-feed line', () => {
    const text = observationCaption({ ...card, symbol: '<TMPV&>', live: {} });
    expect(text).toContain('&lt;TMPV&amp;&gt;');
    expect(text).not.toContain('<TMPV&>');
    expect(text).not.toContain('<b>Live</b>');
    expect(text).toContain('captured-data observation · not advice · final call yours');
  });
});
