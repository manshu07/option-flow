import { marketMovers } from './alerts.mjs';
import { observationSubscriberCaption } from './observationCardSvg.mjs';

const DISCLAIMER = '🎓 educational captured-market data only · not investment advice';
const istClock = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function price(value) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
}

function percent(value) {
  if (!Number.isFinite(value)) return null;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`;
}

function oiAmount(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 100_000) return `${(value / 100_000).toFixed(1)}L`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function nearestWall(series, spot, side) {
  const candidates = (Array.isArray(series?.r) ? series.r : []).filter(row => Array.isArray(row)
    && row[1] === side
    && Number.isFinite(row[0])
    && Number.isFinite(row[4]) && row[4] > 0
    && (side === 0 ? row[0] >= spot : row[0] <= spot));
  candidates.sort((a, b) => side === 0 ? a[0] - b[0] : b[0] - a[0]);
  const row = candidates[0];
  return row ? { strike: row[0], oi: row[4] } : null;
}

function topOiGainer(series, side) {
  const candidates = (Array.isArray(series?.r) ? series.r : []).filter(row => Array.isArray(row)
    && row[1] === side
    && Number.isFinite(row[0])
    && Number.isFinite(row[4]) && Number.isFinite(row[5]) && row[5] > 0
    && row[4] > row[5])
    .map(row => ({ strike: row[0], added: row[4] - row[5], pct: ((row[4] - row[5]) / row[5]) * 100 }));
  candidates.sort((a, b) => b.added - a.added);
  return candidates[0] ?? null;
}

export function liveErrorMessage(symbol, detail) {
  return `${escapeHtml(symbol)}: ${escapeHtml(detail)}\n\n${DISCLAIMER}`;
}

/** Build a command reply only from the captured market file and existing live caches. */
export function liveSnapshotMessage({ symbol, side = null, market, spotReading, futureReading } = {}) {
  const series = (Array.isArray(market?.series) ? market.series : []).find(item => item?.s === symbol);
  if (!series) return liveErrorMessage(symbol, 'no captured snapshot is available yet.');

  const spot = Number.isFinite(spotReading?.ltp) && spotReading.ltp > 0 ? spotReading.ltp : series.sp;
  const prevClose = Number.isFinite(spotReading?.prevClose) && spotReading.prevClose > 0 ? spotReading.prevClose : series.pc;
  const changePct = Number.isFinite(spot) && Number.isFinite(prevClose) && prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : null;
  const spotValue = price(spot);
  const futureValue = price(futureReading?.ltp);
  const moverMarket = Number.isFinite(spot) && spot > 0
    ? { ...market, series: market.series.map(item => item?.s === symbol ? { ...item, sp: spot } : item) }
    : market;
  const movers = marketMovers(moverMarket);
  const mover = movers.find(item => item.symbol === symbol);
  const walls = spotValue ? {
    ce: nearestWall(series, spot, 0),
    pe: nearestWall(series, spot, 1),
  } : { ce: null, pe: null };
  const sides = side === 'CE' ? [0] : side === 'PE' ? [1] : [0, 1];
  const gainers = sides.map(code => ({ side: code === 0 ? 'CE' : 'PE', value: topOiGainer(series, code) })).filter(item => item.value);
  const asOf = Number.isFinite(market.t) ? istClock.format(market.t) : null;
  const wallText = [
    walls.ce && `CE ${walls.ce.strike} (OI ${oiAmount(walls.ce.oi)})`,
    walls.pe && `PE ${walls.pe.strike} (OI ${oiAmount(walls.pe.oi)})`,
  ].filter(Boolean).join(' · ');
  const gainerText = gainers.map(item => `${item.side} ${item.value.strike} ${percent(item.value.pct)}`).join(' · ');
  const lines = [
    `📡 <b>${escapeHtml(symbol)} snapshot</b>${asOf ? ` · ${asOf} IST` : ''}`,
    spotValue ? `• Spot <b>${spotValue}</b>${percent(changePct) ? ` · day ${percent(changePct)}` : ''}` : '• Spot unavailable in the captured snapshot',
    futureValue ? `• Futures <b>${futureValue}</b> (live cache)` : '• Futures unavailable in this provider\'s live cache',
    mover?.buildup
      ? `• Day read: <b>${mover.buildup}</b> · price ${percent(mover.changePct)} · chain OI ${percent(mover.oiPct)}`
      : '• Day read: no build-up at the 0.5% price / 2% OI floors',
    `• Nearest walls: ${wallText || 'not available'}`,
    `• Top OI gainer${side ? ` (${side})` : 's'}: ${gainerText || 'not available'}`,
    '',
    DISCLAIMER,
  ];
  return lines.join('\n');
}

function oiWallsBySide(series, spot, side, max = 3) {
  return (Array.isArray(series?.r) ? series.r : [])
    .filter(row => Array.isArray(row) && row[1] === side
      && Number.isFinite(row[0]) && Number.isFinite(row[4]) && row[4] > 0
      && (spot ? (side === 0 ? row[0] >= spot : row[0] <= spot) : true))
    .sort((a, b) => b[4] - a[4])
    .slice(0, max);
}

/** `/oi SYMBOL [STRIKE]` — top OI walls, or one strike's CE/PE rows. */
export function oiSnapshotMessage({ symbol, strike = null, market } = {}) {
  const series = (Array.isArray(market?.series) ? market.series : []).find(item => item?.s === symbol);
  if (!series) return liveErrorMessage(symbol, 'no captured snapshot is available yet.');
  const asOf = Number.isFinite(market?.t) ? istClock.format(market.t) : null;
  const spot = Number.isFinite(series?.sp) ? series.sp : null;

  if (Number.isFinite(strike) && strike > 0) {
    const rows = [0, 1].map(side => (series.r ?? []).find(row => Array.isArray(row) && row[1] === side && row[0] === strike))
      .filter(row => row);
    if (!rows.length) return liveErrorMessage(symbol, `no captured rows for strike ${strike}.`);
    const lines = [`📊 <b>${escapeHtml(symbol)} ${strike}</b>${asOf ? ` · ${asOf} IST` : ''}`];
    for (const row of rows) {
      const side = row[1] === 0 ? 'CE' : 'PE';
      const ltp = price(row[2]);
      const prevOi = Number.isFinite(row[5]) && row[5] > 0 ? row[5] : null;
      const oiPct = Number.isFinite(row[4]) && prevOi ? ((row[4] - prevOi) / prevOi) * 100 : null;
      lines.push(`• ${side}: LTP ${ltp ?? '—'} · OI ${oiAmount(row[4]) ?? '—'}${percent(oiPct) ? ` · day ${percent(oiPct)}` : ''}`);
    }
    lines.push('', DISCLAIMER);
    return lines.join('\n');
  }

  const wallLines = [0, 1].map(side => {
    const label = side === 0 ? 'CE' : 'PE';
    const walls = oiWallsBySide(series, spot, side);
    if (!walls.length) return null;
    return `${label} walls: ${walls.map(row => `${row[0]} (${oiAmount(row[4])})`).join(' · ')}`;
  }).filter(Boolean);
  if (!wallLines.length) return liveErrorMessage(symbol, 'no captured OI rows are available yet.');
  return [`📊 <b>${escapeHtml(symbol)} OI walls</b>${asOf ? ` · ${asOf} IST` : ''}`, ...wallLines, '', DISCLAIMER].join('\n');
}

/** `/obs SYMBOL` — the symbol's newest observation cards, stripped subscriber copy. */
export function obsSnapshotMessage({ symbol, observations = [], max = 3 } = {}) {
  const cards = (Array.isArray(observations) ? observations : [])
    .filter(card => card?.symbol === symbol && Number.isFinite(card?.strike))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, Math.max(1, max));
  if (!cards.length) return `${escapeHtml(symbol)}: no observations yet.\n\n${DISCLAIMER}`;
  return cards.map(card => observationSubscriberCaption(card)).join('\n\n');
}
