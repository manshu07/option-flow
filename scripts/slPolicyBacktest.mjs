/**
 * SL policy backtest: touch-based SL vs 5-minute close-based SL.
 *   node scripts/slPolicyBacktest.mjs 2026-11-18 2026-11-26
 *
 * For every observation card (incl. today's open cards), walks its captured
 * 5-minute premium candles from card.at:
 *  - touch-SL : any candle low <= sl            (current journal semantics)
 *  - close-SL : any 5-min candle CLOSE < sl     (proposed policy)
 * Reports per policy: SL count, TGT1 count, still-open, and for close-SL the
 * extra adverse distance endured past the stop before the closing print.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [fromArg, toArg] = process.argv.slice(2);
const FROM = fromArg ?? '2026-11-18';
const TO = toArg ?? '2026-11-26';

const store = JSON.parse(readFileSync(path.join(ROOT, 'server', 'data', 'observations.json'), 'utf8'));
const cards = (Array.isArray(store.cards) ? store.cards : []).filter(c =>
  typeof c.at === 'number' && Number.isFinite(c.strike) && Number.isFinite(c.sl) && Number.isFinite(c.tgt1)
  && c.date >= FROM && c.date <= TO);
if (!cards.length) { console.log('no cards in range'); process.exit(0); }

function minuteFiles(date) {
  const dir = path.join(ROOT, 'server', 'data', 'dhan', date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[01]\d{3}\.json$/.test(f)).sort()
    .map(f => ({ at: Date.parse(`2026-11-${date.slice(8)}T${f.slice(0, 2)}:${f.slice(2)}:00+05:30`), f: path.join(dir, f) }));
}

function ltpSeriesFor(card) {
  const series = [];
  for (const { at, f } of minuteFiles(card.date)) {
    try {
      const snap = JSON.parse(readFileSync(f, 'utf8'));
      const s = (snap.series ?? []).find(x => x.s === card.symbol);
      if (!s) continue;
      const rows = [...(s.r ?? []), ...(s.next?.r ?? [])];
      const sideCode = card.side === 'CE' ? 0 : 1;
      const v = rows.filter(r => Number(r[0]) === Number(card.strike) && Number(r[1]) === sideCode).map(r => Number(r[2]))[0];
      if (Number.isFinite(v)) series.push({ at, v });
    } catch { /* skip bad minute */ }
  }
  return series;
}

// 5-minute buckets: close of each bucket = last print inside it.
function close5(series, cardAt) {
  const buckets = new Map();
  for (const p of series) {
    if (p.at < cardAt) continue;
    const bucket = Math.floor(p.at / (5 * 60_000)) * 5 * 60_000;
    buckets.set(bucket, p.v);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, close]) => ({ at, close }));
}

let touchSL = 0, closeSL = 0, touchTGT = 0, closeTGT = 0, openBoth = 0, extraLoss = [];
let mixedTGT = 0, mixedSL = 0, mixedOpen = 0;
let perSymbol = [];
for (const card of cards) {
  const series = ltpSeriesFor(card);
  if (series.length < 2) continue;
  const bull = card.bias === 'bullish' || (card.side === 'CE');
  const closes = close5(series, card.at);
  let tSL = null, cSL = null, tTG = null, cTG = null;
  let worstAfterCloseStop = null;
  for (const p of series) {
    if (tSL == null && ((bull && p.v <= card.sl) || (!bull && p.v >= card.sl))) tSL = p;
  }
  for (const b of closes) {
    if (cSL == null && ((bull && b.close < card.sl) || (!bull && b.close > card.sl))) cSL = b;
    if (tTG == null && ((bull && series.find(p => p.at <= b.at && p.v >= card.tgt1)))) { /* handled below */ }
  }
  for (const p of series) {
    if (tTG == null && ((bull && p.v >= card.tgt1) || (!bull && p.v <= card.tgt1))) tTG = p;
  }
  for (const b of closes) {
    if (cTG == null && ((bull && b.close >= card.tgt1) || (!bull && b.close <= card.tgt1))) cTG = b;
  }
  // close-SL: how far past the stop did price go before the closing print fired?
  if (cSL) {
    const after = series.filter(p => p.at >= cSL.at);
    if (!after.length) worstAfterCloseStop = 0; // closing print itself was the extreme
    else {
      const worst = bull ? Math.min(...after.map(p => p.v)) : Math.max(...after.map(p => p.v));
      worstAfterCloseStop = Math.abs(worst - card.sl);
    }
  }
  if (tSL) touchSL++;
  if (cSL) closeSL++;
  if (tTG) touchTGT++;
  if (cTG) closeTGT++;
  if (!tSL && !tTG) openBoth++;
  // MIXED policy (owner 2026-11-26): TGT on touch, SL only on 5-min close.
  // Whichever fires first wins: a touch-TGT before any close-SL is a TGT win.
  const firstCloseSL = cSL;
  const firstTouchTG = tTG;
  if (firstTouchTG && (!firstCloseSL || firstTouchTG.at < firstCloseSL.at)) mixedTGT++;
  else if (firstCloseSL && (!firstTouchTG || firstCloseSL.at < firstTouchTG.at)) mixedSL++;
  else mixedOpen++;
  if (cSL && worstAfterCloseStop != null) extraLoss.push({ card: `${card.symbol} ${card.strike}${card.side}`, extra: worstAfterCloseStop });
  perSymbol.push(`${String(card.at).slice(0, 0)}${new Date(card.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).slice(12)} ${card.symbol.padEnd(11)} ${card.strike}${card.side}: touch=${tSL ? 'SL' : tTG ? 'TGT' : 'open'} | close=${cSL ? 'SL' : cTG ? 'TGT' : 'open'}${cSL ? ` (extra ${worstAfterCloseStop.toFixed(2)} beyond stop)` : ''}`);
}

console.log(`cards analysed: ${cards.length}`);
console.log(`touch-SL policy : SL ${touchSL} · TGT1 ${touchTGT} · open ${cards.length - touchSL - touchTGT}`);
console.log(`close-SL policy : SL ${closeSL} · TGT1 ${closeTGT} · open ${cards.length - closeSL - closeTGT}`);
const avgExtra = extraLoss.length ? (extraLoss.reduce((s, e) => s + e.extra, 0) / extraLoss.length).toFixed(2) : '-';
console.log(`close-SL extra adverse distance beyond stop: avg ${avgExtra} pts over ${extraLoss.length} stops`);
console.log(`MIXED policy (TGT=touch, SL=5min-close): SL ${mixedSL} · TGT1 ${mixedTGT} · open ${mixedOpen}`);
console.log('--- per card ---');
for (const line of perSymbol) console.log(line);
