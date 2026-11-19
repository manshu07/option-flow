/**
 * Morning brief — top 5 bullish and top 5 bearish names with their levels, plus
 * three supports and three resistances for NIFTY / BANKNIFTY / SENSEX.
 *
 *   node --env-file-if-exists=.env scripts/sendMorningBrief.mjs [--dry]
 *
 * Levels are the captured chain's open-interest walls: the heaviest PE strikes
 * at or below spot are supports, the heaviest CE strikes at or above spot are
 * resistances. Before the open the market file is the previous session's close,
 * so the brief says which session it stands for instead of pretending it is live.
 */
import { readFileSync, existsSync } from 'node:fs';
import { marketMovers } from '../server/alerts.mjs';
import { sendTelegram } from '../server/telegram.mjs';
import { activeChatIds, loadSubscribers } from '../server/subscribers.mjs';

const DATA = new URL('../server/data/', import.meta.url);
const dry = process.argv.includes('--dry');
const market = JSON.parse(readFileSync(new URL('dhan/latest.json', DATA), 'utf8'));
const seriesOf = symbol => (market.series ?? []).find(item => item.s === symbol) ?? null;
const price = value => Number.isFinite(value) ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
const pct = value => Number.isFinite(value) ? `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%` : '—';
const oiText = value => Number.isFinite(value) ? `${(value / 100_000).toFixed(2)}L` : '—';
const escapeHtml = text => String(text).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

/** Heaviest OI strikes on each side of spot, nearest first when OI ties. */
function walls(series, count = 3) {
  const spot = series?.sp;
  if (!Number.isFinite(spot)) return { supports: [], resistances: [] };
  const supports = [];
  const resistances = [];
  for (const row of series.r ?? []) {
    if (!Array.isArray(row) || !(row[4] > 0)) continue;
    const entry = { strike: row[0], oi: row[4], changePct: row[5] > 0 ? ((row[4] - row[5]) / row[5]) * 100 : null };
    if (row[1] === 1 && row[0] <= spot) supports.push(entry);
    if (row[1] === 0 && row[0] >= spot) resistances.push(entry);
  }
  supports.sort((a, b) => b.oi - a.oi);
  resistances.sort((a, b) => b.oi - a.oi);
  return { supports: supports.slice(0, count), resistances: resistances.slice(0, count) };
}

const movers = marketMovers(market);
const bulls = movers.filter(m => m.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 5);
const bears = movers.filter(m => m.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 5);

const stamp = new Date(market.t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const lines = [
  `🌅 <b>Morning brief</b> · based on ${escapeHtml(stamp)} IST close`,
  'Levels are open-interest walls from the captured chain — where the most contracts sit.',
  '',
];

const moverLine = mover => {
  const series = seriesOf(mover.symbol);
  const { supports, resistances } = walls(series, 1);
  const support = supports[0];
  const resistance = resistances[0];
  const expiry = series?.e ?? '—';
  const build = mover.buildup ? ` · ${mover.buildup}` : '';
  return `• <b>${escapeHtml(mover.symbol)}</b> ${price(mover.spot)} (${pct(mover.changePct)}) · OI ${pct(mover.oiPct)}${build}\n`
    + `   support ${support ? price(support.strike) : '—'} · resistance ${resistance ? price(resistance.strike) : '—'} · expiry ${escapeHtml(expiry)}`;
};

lines.push('<b>Top 5 bullish</b>');
lines.push(...(bulls.length ? bulls.map(moverLine) : ['— no advancing names in the last capture']));
lines.push('', '<b>Top 5 bearish</b>');
lines.push(...(bears.length ? bears.map(moverLine) : ['— no declining names in the last capture']));

lines.push('', '<b>Index levels — 3 supports / 3 resistances</b>');
for (const symbol of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
  const series = seriesOf(symbol);
  if (!series || !(series.r ?? []).length) {
    lines.push(`• <b>${symbol}</b> — chain not captured, no levels quoted`);
    continue;
  }
  const { supports, resistances } = walls(series, 3);
  const fmt = list => list.length ? list.map(w => `${price(w.strike)} (${oiText(w.oi)})`).join(' · ') : '—';
  // Index spot has no captured previous close (pc === sp), so a spot day
  // change would be a fake 0.00%. Quote the future's own day change instead.
  let changeText = '';
  const futFile = new URL(`dhan/${market.date}/futures/${symbol}.json`, DATA);
  if (existsSync(futFile)) {
    try {
      const month = JSON.parse(readFileSync(futFile, 'utf8'))?.months?.[0];
      const last = month?.candles?.at(-1)?.close;
      if (Number.isFinite(last) && Number.isFinite(month?.prevClose) && month.prevClose > 0) {
        changeText = ` · fut ${price(last)} (${pct(((last - month.prevClose) / month.prevClose) * 100)})`;
      }
    } catch { /* no futures read: leave the change off rather than invent it */ }
  }
  lines.push(`• <b>${symbol}</b> ${price(series.sp)}${changeText} · expiry ${escapeHtml(series.e ?? '—')}`);
  lines.push(`   support: ${fmt(supports)}`);
  lines.push(`   resistance: ${fmt(resistances)}`);
}

lines.push('', 'Support = heaviest put OI at/below price · resistance = heaviest call OI at/above price. A wall is where price tends to stall, not a guaranteed turn.');
lines.push('Options decay every day — prefer the next-month expiry for a multi-day hold.');
lines.push('🎓 educational captured market data · not investment advice');

const message = lines.join('\n');
console.log(message.replace(/<[^>]+>/g, ''));

if (dry) { console.log('\n(--dry: nothing sent)'); process.exit(0); }

const ownerChatId = process.env.TELEGRAM_CHAT_ID ?? null;
const recipients = [...new Set([
  ...(ownerChatId ? [Number(ownerChatId)] : []),
  ...activeChatIds(loadSubscribers(new URL('subscribers.json', DATA).pathname)),
])];
console.log('\nsending to', recipients);
for (const chatId of recipients) {
  const result = await sendTelegram(message, { chatId, parseMode: 'HTML', retry: true });
  console.log(chatId, result?.sent ? 'sent' : `NOT sent (${result?.reason ?? result?.status ?? 'unknown'})`);
}