import { readFileSync } from 'node:fs';
import { eodJournalBody, marketMovers, nextDayPlanMessage } from '../server/alerts.mjs';
import { loadObservations } from '../server/strikeAdvisor.mjs';
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
const observations = loadObservations(new URL('observations.json', DATA_DIR).pathname);
const journal = eodJournalBody(observations, market.date, 700);
const footer = '📊 educational market-data digest · not investment advice · /stop to opt out';
const journalMessage = journal ? `${journal}\n\n${footer}` : null;

console.log('--- watchlist ---');
console.log(plan ?? '(null)');
console.log('--- journal (sample: yesterday) ---');
console.log(journalMessage ?? '(null)');

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerChatId = process.env.TELEGRAM_CHAT_ID ?? null;
const recipients = [...new Set([
  ...(ownerChatId ? [Number(ownerChatId)] : []),
  ...activeChatIds(loadSubscribers(new URL('subscribers.json', DATA_DIR).pathname)),
])];
console.log('--- sending to ---', recipients);
for (const message of [plan, journalMessage]) {
  if (!message) continue;
  for (const chatId of recipients) {
    const result = await sendTelegram(message, { chatId, parseMode: 'HTML', retry: true });
    console.log(chatId, result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status ?? 'unknown'})`);
  }
}
