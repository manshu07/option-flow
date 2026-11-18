import { readFileSync } from 'node:fs';
import { sendTelegram } from '../server/telegram.mjs';
import { activeChatIds, loadSubscribers } from '../server/subscribers.mjs';

const DATA_DIR = new URL('../server/data/', import.meta.url);
const footer = '📊 educational market-data · not investment advice · /stop to opt out';

const guide = `🤖 <b>Order Flow bot — what it can do</b>

<b>You receive (no need to ask):</b>
• 15:45 daily report — build-ups, top movers, support/resistance moves, journal outcomes, next-day watchlist
• NIFTY OI-spike alert when a big strike moves
• Your own price alerts, instantly

<b>Commands — ask and get:</b>
/start — subscribe
/live RELIANCE — live snapshot: price, day read, walls
/obs TMPV — newest observation cards for TMPV
/oi TMPV — biggest OI walls · /oi TMPV 265 — that strike's CE + PE
/watch TMPV — follow TMPV (its build-ups reach you)
/unwatch TMPV — stop following
/journal — today's calls: TGT1 hit? YES / NO
/alert NIFTY above 25000 — your own alert
/alerts — your alerts list · /unalert ID — remove one

<b>Example:</b> send /live RELIANCE → you get spot, day move, BUY/SELL read, nearest walls.

${footer}`;

const recipients = [...new Set([
  ...(process.env.TELEGRAM_CHAT_ID ? [Number(process.env.TELEGRAM_CHAT_ID)] : []),
  ...activeChatIds(loadSubscribers(new URL('subscribers.json', DATA_DIR).pathname)),
])];
console.log('sending to', recipients);
for (const chatId of recipients) {
  const result = await sendTelegram(guide, { chatId, parseMode: 'HTML', retry: true });
  console.log(chatId, result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status ?? 'unknown'})`);
}
