import { readFileSync } from 'node:fs';
import { marketMovers, nextDayPlanMessage } from '../server/alerts.mjs';
import { sendTelegram } from '../server/telegram.mjs';
import { activeChatIds, loadSubscribers } from '../server/subscribers.mjs';

const DATA_DIR = new URL('../server/data/', import.meta.url);
const market = JSON.parse(readFileSync(new URL('dhan/latest.json', DATA_DIR), 'utf8'));

// Today's watchlist is yesterday's session carry-forward: the real build-ups the
// floors caught at close, ranked by |chain OI %|, capped at five.
const movers = marketMovers(market);
const buildups = movers
  .filter(mover => mover.buildup)
  .sort((left, right) => Math.abs(right.oiPct) - Math.abs(left.oiPct))
  .slice(0, 5);
const dailyEvents = new Map(buildups.map((mover, index) => [
  `buildup:send-now-${index}`,
  { rule: { type: 'buildup', id: `send-now-${index}`, symbol: mover.symbol }, items: [] },
]));

const plan = nextDayPlanMessage(market, dailyEvents, { date: market.date });
console.log('--- plan message ---');
console.log(plan ?? '(null — no candidates)');
if (!plan) process.exit(1);

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerChatId = process.env.TELEGRAM_CHAT_ID ?? null;
const recipients = [...new Set([
  ...(ownerChatId ? [Number(ownerChatId)] : []),
  ...activeChatIds(loadSubscribers(new URL('subscribers.json', DATA_DIR).pathname)),
])];
console.log('--- sending to ---', recipients);
for (const chatId of recipients) {
  const result = await sendTelegram(plan, { chatId, parseMode: 'HTML', retry: true });
  console.log(chatId, result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status ?? 'unknown'})`);
}
