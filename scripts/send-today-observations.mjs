/**
 * Send a day's observation cards to subscribers.
 *
 *   node --env-file-if-exists=.env scripts/send-today-observations.mjs [date] [--each] [--dry]
 *
 * Default: one grouped message per subscriber (Telegram's 4096-char limit).
 * `--each`: one message per card — the owner's ask on 2026-11-19.
 *
 * Only actionable cards go out: a `no-edge` card (nothing pays 1:2) or one still
 * on fixed percentages is not a trade, so it is skipped and reported.
 * Subscribers always get the stripped copy — no quality, model or Jev wording.
 */
import { readFileSync } from 'node:fs';
import { observationSubscriberCaption } from '../server/observationCardSvg.mjs';
import { sendTelegram } from '../server/telegram.mjs';

const DATA = new URL('../server/data/', import.meta.url);
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const each = args.includes('--each');
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  ?? new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);

const obs = JSON.parse(readFileSync(new URL('observations.json', DATA), 'utf8'));
const all = (obs.cards ?? obs).filter(card => card.date === date).sort((a, b) => a.at - b.at);
// Actionable = has real levels AND a positive measured expectancy. The advisor
// applies this guard at build time; a re-priced card can predate it.
const minExpectancy = Number(process.env.ADVISOR_MIN_EXPECTANCY ?? 0);
const sendable = all.filter(card => {
  if (['no-edge', 'fixed'].includes(card.levelsBasis ?? 'fixed')) return false;
  const exp = card.backtest?.expectancyPremium;
  return !(Number.isFinite(exp) && exp < minExpectancy);
});
const skipped = all.filter(card => !sendable.includes(card));

console.log(`${date}: ${all.length} cards · ${sendable.length} sendable · ${skipped.length} skipped`);
for (const card of skipped) {
  const exp = card.backtest?.expectancyPremium;
  const why = card.levelsRejected ?? (Number.isFinite(exp) && exp < minExpectancy ? `negative expectancy ₹${exp}` : '');
  console.log(`  skip ${card.symbol} ${card.strike}${card.side} — ${card.levelsBasis}${why ? ` (${why.slice(0, 60)})` : ''}`);
}

const subs = JSON.parse(readFileSync(new URL('subscribers.json', DATA), 'utf8'));
const owner = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID) : null;
const recipients = subs.subscribers.filter(s => s.active).map(s => s.chatId).filter(id => String(id) !== owner);
console.log('recipients', recipients, each ? '(one message per card)' : '(grouped)');

if (dry) {
  console.log('\n--- first caption preview ---\n' + (sendable[0] ? observationSubscriberCaption(sendable[0]) : '(none)'));
  process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sent = 0;
let failed = 0;

if (each) {
  for (const card of sendable) {
    const caption = observationSubscriberCaption(card);
    for (const chatId of recipients) {
      const result = await sendTelegram(caption, { chatId, parseMode: 'HTML', retry: true });
      if (result?.sent) sent++; else failed++;
      console.log(`${card.symbol} ${card.strike}${card.side} → ${chatId} ${result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status})`}`);
      await sleep(120); // stay under Telegram's per-chat rate limit
    }
  }
} else {
  const chunks = [];
  let current = `🗂 <b>Observations</b> · ${date}\n`;
  for (const card of sendable) {
    const caption = observationSubscriberCaption(card);
    if ((current + '\n\n' + caption).length > 3800) { chunks.push(current); current = ''; }
    current += (current ? '\n\n' : '') + caption;
  }
  if (current.trim()) chunks.push(current);
  for (const chatId of recipients) {
    for (const [index, text] of chunks.entries()) {
      const result = await sendTelegram(text, { chatId, parseMode: 'HTML', retry: true });
      if (result?.sent) sent++; else failed++;
      console.log(chatId, `chunk ${index + 1}/${chunks.length}`, result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status})`);
      await sleep(120);
    }
  }
}
console.log(`\ndone: ${sent} sent, ${failed} failed`);