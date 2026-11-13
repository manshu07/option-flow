import { expect, test, type Page, type Route } from '@playwright/test';
import {
  CAPTURED_MINUTES,
  FUTURES_AFTER_AS_OF,
  FUTURES_BY_AS_OF,
  GAP_MINUTE,
  MANIFEST,
  MARKET_BY_MINUTE,
  REPLAY_DATE,
  fixtureEpoch,
  marketSnapshot,
} from './fixtures/replay-fixture';

// The shared fixture has unique, indexed timestamps; the UI mock keeps the
// 14:47 as-of boundary explicit without inventing a duplicate minute.
const MOCK_CAPTURED_MINUTES = [...CAPTURED_MINUTES];
const MOCK_MANIFEST = { ...MANIFEST, minutes: MOCK_CAPTURED_MINUTES.map(minute => [minute, fixtureEpoch(minute)]) };
const MOCK_MARKET_BY_MINUTE = { ...MARKET_BY_MINUTE, '1447': marketSnapshot('1447', 1047) };

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function expectNoExternal(network: { externalRequests: string[]; seenDhanRequests: string[] }) {
  expect(network.externalRequests).toEqual([]);
  expect(network.seenDhanRequests).toEqual([]);
}

/**
 * The replay API is stubbed here, at the browser HTTP boundary. The page shell,
 * live API paths, static assets, and recorded provider process remain real.
 */
async function stubReplayApi(page: Page, failOnceMinute?: string, missingMinute?: string, failOnceFutureSymbol?: string) {
  const externalRequests: string[] = [];
  const seenDhanRequests: string[] = [];
  const marketReads: string[] = [];
  const futuresReads: string[] = [];
  const failedMinutes = new Set<string>();
  const failedFutures = new Set<string>();

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (/dhan/i.test(url.hostname + url.pathname)) {
      seenDhanRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      externalRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }

    const manifestPath = `/api/replay/${REPLAY_DATE}/manifest`;
    const marketMatch = url.pathname.match(new RegExp(`^/api/market/${REPLAY_DATE}/(\\d{4})$`));
    const futuresMatch = url.pathname.match(new RegExp(`^/api/replay/${REPLAY_DATE}/futures/([A-Za-z0-9&._-]+)$`));
    if (url.pathname === manifestPath) {
      await json(route, MOCK_MANIFEST);
      return;
    }
    if (marketMatch) {
      const minute = marketMatch[1];
      marketReads.push(minute);
      if (minute === missingMinute) {
        await json(route, { error: 'No such minute.' }, 404);
        return;
      }
      if (minute === failOnceMinute && !failedMinutes.has(minute)) {
        failedMinutes.add(minute);
        await json(route, { error: 'Temporary read failure.' }, 503);
        return;
      }
      const snapshot = MOCK_MARKET_BY_MINUTE[minute as keyof typeof MOCK_MARKET_BY_MINUTE];
      await (snapshot ? json(route, snapshot) : json(route, { error: 'No such minute.' }, 404));
      return;
    }
    if (futuresMatch) {
      const symbol = futuresMatch[1];
      const asOf = url.searchParams.get('asOf') ?? '';
      futuresReads.push(`${symbol}?asOf=${asOf}`);
      if (symbol === failOnceFutureSymbol && !failedFutures.has(symbol)) {
        failedFutures.add(symbol);
        await json(route, { error: 'Temporary futures read failure.' }, 503);
        return;
      }
      await json(route, asOf === '1447' ? FUTURES_BY_AS_OF : FUTURES_AFTER_AS_OF);
      return;
    }
    await route.continue();
  });

  return { externalRequests, seenDhanRequests, marketReads, futuresReads };
}

/** Real-server coverage: only replay endpoints pass through; live reads stay stubbed. */
async function allowRealReplayApi(page: Page) {
  const externalRequests: string[] = [];
  const seenDhanRequests: string[] = [];
  const replayRequests: string[] = [];
  const liveStubRequests: string[] = [];
  const manifestPath = `/api/replay/${REPLAY_DATE}/manifest`;
  const marketPath = new RegExp(`^/api/market/${REPLAY_DATE}/\\d{4}$`);
  const futuresPath = new RegExp(`^/api/replay/${REPLAY_DATE}/futures/RELIANCE$`);

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = `${url.pathname}${url.search}`;
    if (/dhan/i.test(url.hostname + url.pathname)) {
      seenDhanRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      externalRequests.push(request.url());
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === manifestPath || marketPath.test(url.pathname) || futuresPath.test(url.pathname)) {
      replayRequests.push(requestPath);
      await route.continue();
      return;
    }
    if (url.pathname === '/api/futures/RELIANCE' && url.searchParams.get('e2ePersist') === '1') {
      replayRequests.push(requestPath);
      await route.continue();
      return;
    }
    if (url.pathname === '/api/market') {
      liveStubRequests.push(requestPath);
      await json(route, MARKET_BY_MINUTE['1530']);
      return;
    }
    if (url.pathname.startsWith('/api/futures/')) {
      liveStubRequests.push(requestPath);
      await json(route, FUTURES_AFTER_AS_OF);
      return;
    }
    await route.continue();
  });

  return { externalRequests, seenDhanRequests, replayRequests, liveStubRequests };
}

async function openReplay(page: Page) {
  await page.goto('/market-flow');
  const trigger = page.getByTestId('flow-replay-open');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId('flow-replay-time')).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Market replay' });
  const phone = (page.viewportSize()?.width ?? 1280) <= 768;
  await expect(dialog).toHaveClass(phone ? /is-sheet/ : /is-popover/);
  if (phone) {
    expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect((await page.getByTestId('flow-replay-slider').boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
}

async function seekTo(page: Page, index: number) {
  await page.getByTestId('flow-replay-slider').evaluate((element, value) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
}

test.describe('replay transport', () => {
  test('runs in Microsoft Edge for the Edge project', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-edge', 'Edge channel assertion');
    const network = await stubReplayApi(page);
    await page.goto('/market-flow');
    expect(await page.evaluate(() => navigator.userAgent)).toMatch(/Edg\//);
    expectNoExternal(network);
  });

  test('opens with the captured timeline and preserves live controls', async ({ page }) => {
    const network = await stubReplayApi(page);
    await page.goto('/market-flow');
    await expect(page.getByTestId('flow-replay-open')).toBeVisible();

    const status = await page.request.get('/api/status');
    expect((await status.json()).provider.id).toBe('recorded');

    const universe = page.getByRole('radiogroup', { name: 'Underlyings' });
    const theme = page.getByRole('switch', { name: /Theme:/ });
    await expect(universe).toBeVisible();
    await expect(theme).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Nifty 50' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'All F&O' })).toBeVisible();

    await page.getByTestId('flow-replay-open').click();
    await expect(page.getByTestId('flow-replay-time')).toContainText(/09:15|09:30|10:00/);
    await expect(page.getByTestId('flow-replay-slider')).toBeVisible();
    expectNoExternal(network);
  });

  test('supports play, pause, seek, end, and return-live', async ({ page }) => {
    const network = await stubReplayApi(page);
    await openReplay(page);
    const time = page.getByTestId('flow-replay-time');
    await seekTo(page, 0);
    const initial = await time.textContent();

    await page.getByTestId('flow-replay-play').click();
    await expect(time).not.toHaveText(initial ?? '');
    await page.getByTestId('flow-replay-play').click();

    await seekTo(page, 0);
    await expect(time).toContainText('09:15');
    await seekTo(page, MOCK_CAPTURED_MINUTES.length - 1);
    await expect(time).toContainText('15:30');

    await page.getByTestId('flow-replay-live').click();
    await expect(page.getByTestId('flow-replay-open')).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Underlyings' })).toBeVisible();
    await expect(page.getByRole('switch', { name: /Theme:/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Market replay' })).toHaveCount(0);
    await expect(page.locator('.mf-status__source')).toContainText('Recorded · replay');
    const nifty = page.getByRole('radio', { name: 'Nifty 50' });
    const allFno = page.getByRole('radio', { name: 'All F&O' });
    await nifty.click();
    await expect(nifty).toHaveAttribute('aria-checked', 'true');
    await allFno.click();
    await expect(allFno).toHaveAttribute('aria-checked', 'true');
    const previousTheme = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('switch', { name: /Theme:/ }).click();
    expect(await page.locator('html').getAttribute('data-theme')).not.toBe(previousTheme);
    expectNoExternal(network);
  });

  test('handles gaps and partial capture without selecting a later snapshot', async ({ page }) => {
    const network = await stubReplayApi(page);
    await openReplay(page);

    await seekTo(page, 1);
    await expect(page.getByTestId('flow-replay-time')).toContainText('09:30');
    await seekTo(page, 2);
    await expect(page.getByTestId('flow-replay-time')).toContainText('10:00');
    await expect(page.getByText(/Replay futures unavailable/)).toBeVisible();
    expect(network.marketReads).not.toContain(GAP_MINUTE);
    expect(CAPTURED_MINUTES).toContain('1000');
    expectNoExternal(network);
  });

  test('retries a failed market-minute read without leaving replay', async ({ page }) => {
    const network = await stubReplayApi(page, '1000');
    await openReplay(page);
    await seekTo(page, CAPTURED_MINUTES.indexOf('1000'));
    await expect(page.getByTestId('flow-replay-retry')).toBeVisible();
    await page.getByTestId('flow-replay-retry').click();
    await expect(page.getByTestId('flow-replay-time')).toContainText('10:00');
    await expect(page.getByTestId('flow-replay-retry')).toHaveCount(0);
    expect(network.marketReads.filter(minute => minute === '1000')).toHaveLength(2);
    expectNoExternal(network);
  });

  test('retries the session bootstrap when its final captured snapshot is temporarily unavailable', async ({ page }) => {
    const network = await stubReplayApi(page, '1530');
    await page.goto('/market-flow');
    await expect(page.getByTestId('flow-replay-open')).toBeVisible();
    await page.getByTestId('flow-replay-open').click();
    await expect(page.getByTestId('flow-replay-retry')).toBeVisible();
    await page.getByTestId('flow-replay-retry').click();
    await expect(page.getByTestId('flow-replay-time')).toBeVisible();
    expect(network.marketReads.filter(minute => minute === '1530')).toHaveLength(2);
    expectNoExternal(network);
  });

  test('retries transient futures failures without restarting the session', async ({ page }) => {
    const network = await stubReplayApi(page, undefined, undefined, 'RELIANCE');
    await openReplay(page);
    await expect(page.getByTestId('flow-replay-futures-retry')).toBeVisible();
    await page.getByTestId('flow-replay-futures-retry').click();
    await expect(page.getByTestId('flow-replay-futures-retry')).toHaveCount(0);
    await expect(page.getByTestId('flow-replay-time')).toContainText('09:15');
    expect(network.futuresReads.filter(read => read.startsWith('RELIANCE?'))).toHaveLength(2);
    expectNoExternal(network);
  });

  test('does not advance to a later snapshot when a listed minute is missing', async ({ page }) => {
    const network = await stubReplayApi(page, undefined, '1000');
    await openReplay(page);
    await seekTo(page, CAPTURED_MINUTES.indexOf('1000'));
    await expect(page.getByTestId('flow-replay-time')).toContainText('10:00');
    await expect(page.getByTestId('flow-replay-retry')).toBeVisible();
    await page.getByTestId('flow-replay-play').click();
    await expect(page.getByTestId('flow-replay-time')).toContainText('10:00');
    expect(network.marketReads.filter(minute => minute === '1000')).toHaveLength(2);
    expect(network.marketReads).not.toContain('1450');
    expectNoExternal(network);
  });

  test('is deterministic for repeated timestamps and has no look-ahead at 14:47', async ({ page }) => {
    const network = await stubReplayApi(page);
    await openReplay(page);
    const replayIndex = MOCK_CAPTURED_MINUTES.indexOf('1445');
    await seekTo(page, replayIndex);
    await expect(page.getByTestId('flow-replay-time')).toContainText('14:45');
    await expect(page.locator('.mf-status__time')).toContainText('14:45');
    const first = await page.locator('.mf-status__counts').textContent();
    const replayIndex1447 = MOCK_CAPTURED_MINUTES.indexOf('1447');
    await seekTo(page, replayIndex1447);
    await expect(page.getByTestId('flow-replay-time')).toContainText('14:47');
    await expect(page.locator('.mf-status__time')).toContainText('14:47');
    const at1447 = await page.locator('.mf-status__counts').textContent();
    await seekTo(page, replayIndex);
    await expect(page.locator('.mf-status__time')).toContainText('14:45');
    await expect(page.locator('.mf-status__counts')).toHaveText(first ?? '');
    await seekTo(page, replayIndex1447);
    await expect(page.locator('.mf-status__time')).toContainText('14:47');
    await expect(page.locator('.mf-status__counts')).toHaveText(at1447 ?? '');
    expect(network.marketReads.filter(minute => minute === '1445')).toHaveLength(1);

    const payload = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
      return response.json();
    }, `/api/replay/${REPLAY_DATE}/futures/RELIANCE?asOf=1447`);
    const candles = payload.months.flatMap((month: { candles: { at: number }[] }) => month.candles);
    expect(candles.every((candle: { at: number }) => candle.at + 60_000 <= fixtureEpoch('1447'))).toBeTruthy();
    expect(candles.some((candle: { at: number }) => candle.at === fixtureEpoch('1447'))).toBeFalsy();
    expectNoExternal(network);
  });

  test('renders the board using only completed futures candles at the playhead', async ({ page }) => {
    const network = await stubReplayApi(page);
    await openReplay(page);
    const replayIndex = MOCK_CAPTURED_MINUTES.indexOf('1447');
    await seekTo(page, replayIndex);
    await expect(page.getByTestId('flow-replay-time')).toContainText('14:47');
    await expect(page.locator('.mf-status__time')).toContainText('futures to 14:46');
    expect(network.futuresReads).toContain('RELIANCE?asOf=1530');
    expectNoExternal(network);
  });

  test('reads manifest, market, and futures replay data from the real local server', async ({ page }) => {
    const network = await allowRealReplayApi(page);
    await page.goto('/market-flow');
    const status = await page.evaluate(async () => (await fetch('/api/status')).json());
    expect(status.provider.id).toBe('recorded');

    const persisted = await page.evaluate(async date => {
      const response = await fetch(`/api/futures/RELIANCE?session=${date}&e2ePersist=1`);
      return { ok: response.ok, body: await response.json() };
    }, REPLAY_DATE);
    expect(persisted.ok).toBe(true);
    expect(persisted.body.months.length).toBeGreaterThan(0);

    await page.getByTestId('flow-replay-open').click();
    await expect(page.getByTestId('flow-replay-time')).toBeVisible();
    await expect.poll(() => network.replayRequests).toContain(`/api/replay/${REPLAY_DATE}/manifest`);
    await expect.poll(() => network.replayRequests).toContain(`/api/market/${REPLAY_DATE}/1447`);
    await expect.poll(() => network.replayRequests).toContain(`/api/replay/${REPLAY_DATE}/futures/RELIANCE?asOf=1447`);

    const manifest = await page.evaluate(async path => (await fetch(path)).json(), `/api/replay/${REPLAY_DATE}/manifest`);
    expect(manifest.provider.id).toBe('recorded');
    expect(manifest.minutes.map(([minute]: [string, number]) => minute)).toContain('1447');
    expect(manifest.futures.RELIANCE.available).toBe(true);

    const snapshot = await page.evaluate(async path => (await fetch(path)).json(), `/api/market/${REPLAY_DATE}/1447`);
    expect(snapshot.schema).toBe(1);
    expect(snapshot.date).toBe(REPLAY_DATE);
    expect(snapshot.t).toBe(fixtureEpoch('1447'));

    const fullFutures = await page.evaluate(async path => (await fetch(path)).json(), `/api/replay/${REPLAY_DATE}/futures/RELIANCE?asOf=1530`);
    const futures = await page.evaluate(async path => (await fetch(path)).json(), `/api/replay/${REPLAY_DATE}/futures/RELIANCE?asOf=1447`);
    const fullCandles = fullFutures.months.flatMap((month: { candles: { at: number }[] }) => month.candles);
    const candles = futures.months.flatMap((month: { candles: { at: number }[] }) => month.candles);
    expect(candles.every((candle: { at: number }) => candle.at + 60_000 <= fixtureEpoch('1447'))).toBe(true);
    expect(candles.some((candle: { at: number }) => candle.at === fixtureEpoch('1447'))).toBe(false);
    expect(fullCandles.some((candle: { at: number }) => candle.at >= fixtureEpoch('1447'))).toBe(true);

    expect(network.liveStubRequests.some(path => path === '/api/market')).toBe(true);
    expect(network.liveStubRequests.some(path => path.startsWith('/api/futures/'))).toBe(true);
    expectNoExternal(network);
  });
});
