const escapeXml = value => String(value ?? '—').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})[character]);

const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const priceText = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const signedPct = value => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const oiText = value => Number.isFinite(value) ? `${(value / 1_000_000).toFixed(1)}M OI` : 'OI unavailable';
const DAY_MS = 24 * 60 * 60 * 1_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function wallText(wall, side) {
  if (!wall || !Number.isFinite(wall.strike)) return `${side} wall unavailable`;
  return `${wall.strike} ${side} · ${oiText(wall.oi)}${Number.isFinite(wall.changePct) ? ` · ${signedPct(wall.changePct)}` : ''}`;
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const at = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) return null;
  return { day, month, ordinal: at / DAY_MS };
}

function daysToExpiry(date, expiry) {
  const from = calendarDate(date), until = calendarDate(expiry);
  return from && until ? until.ordinal - from.ordinal : null;
}

function expiryText(date, expiry) {
  const parsed = calendarDate(expiry);
  if (!parsed) return null;
  const dte = daysToExpiry(date, expiry);
  return `${String(parsed.day).padStart(2, '0')}-${MONTHS[parsed.month - 1]}${dte == null ? '' : ` (${dte} DTE)`}`;
}

function timeText(value) {
  if (!Number.isFinite(value)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  const day = get('day'), month = get('month'), hour = get('hour'), minute = get('minute');
  return day && month && hour && minute ? `${day}-${month} ${hour}:${minute} IST` : '';
}

function dealerFlowText(gamma) {
  if (!Number.isFinite(gamma?.flipLevel)) return null;
  const level = Math.round(gamma.flipLevel).toLocaleString('en-US');
  if (gamma.regime === 'gamma-long') return `📐 Dealer flow: RANGE above ${level} — breakouts likely to fade`;
  if (gamma.regime === 'gamma-short') return `📐 Dealer flow: TREND below ${level} — moves can accelerate`;
  return null;
}

function plainDealerNote(note) {
  return note.replace(/\bmax-gamma strike\b/gi, 'highest dealer-flow strike')
    .replace(/\bgamma flip\b/gi, 'dealer-flow level')
    .replace(/\bgamma pin(?: zone)?\b/gi, 'dealer-flow zone')
    .replace(/\bgamma\b/gi, 'dealer flow');
}

function thetaText(dte) {
  if (dte == null || dte > 7) return null;
  if (dte <= 2) return `⏳ ${dte} DTE — expiry-week decay is brutal; treat as a same-day trade only.`;
  return `⏳ ${dte} DTE — theta eats the premium daily; if TGT1 is not hit by 14:30, exit.`;
}

export function observationCaption(card) {
  const side = card?.side === 'PE' ? 'PE' : 'CE';
  const symbol = escapeHtml(card?.symbol ?? 'Unknown');
  const strike = Number.isFinite(card?.strike) ? card.strike : '—';
  const at = timeText(card?.at);
  const expiry = expiryText(card?.date, card?.expiry);
  const entry = card?.entry;
  const relativePct = value => Number.isFinite(value) && Number.isFinite(entry) && entry > 0
    ? `${value >= entry ? '+' : '−'}${Math.round(Math.abs((value / entry - 1) * 100))}%`
    : '—';
  const spotMove = Number.isFinite(card?.spotChangePct)
    ? `${card.spotChangePct >= 0 ? '+' : '−'}${Math.abs(card.spotChangePct).toFixed(1)}%`
    : null;
  const support = Number.isFinite(card?.support?.strike) ? `${card.support.strike} PE` : 'unavailable';
  const resistance = Number.isFinite(card?.resistance?.strike) ? `${card.resistance.strike} CE` : 'unavailable';
  const lines = [
    `🔍 <b>OBSERVATION</b> · ${symbol} ${strike}${side}${expiry ? ` · ${escapeHtml(expiry)}` : ''}${at ? ` · ${escapeHtml(at)}` : ''}`,
    '',
    `Bias: <b>${escapeHtml(String(card?.bias ?? 'neutral').toLowerCase())}</b> · quality <b>${Number.isFinite(card?.quality) ? `${(card.quality * 100).toFixed(0)}%` : 'unavailable'}</b> · strike pick ${Number.isFinite(card?.strikePickProbability) ? `${(card.strikePickProbability * 100).toFixed(0)}%` : 'unavailable'}`,
    '',
    '<b>Trade map</b> (premium)',
    `• Entry ~<b>${priceText(entry)}</b> · spot ${priceText(card?.spot)}${spotMove ? ` (${spotMove})` : ''}`,
    `• 🛑 SL <b>${priceText(card?.sl)}</b> (${relativePct(card?.sl)})`,
    `• 🎯 TGT1 <b>${priceText(card?.tgt1)}</b> (${relativePct(card?.tgt1)})`,
    `• 🎯 TGT2 <b>${priceText(card?.tgt2)}</b> (${relativePct(card?.tgt2)})`,
    '• 🔒 after TGT1 → SL to cost',
    '',
    '<b>Chain walls</b>',
    `• Support ${escapeHtml(support)} · Resistance ${escapeHtml(resistance)}`,
  ];

  if (card?.gamma && typeof card.gamma === 'object') {
    const dealerFlow = dealerFlowText(card.gamma);
    const pin = typeof card.gamma.pin === 'string' && card.gamma.pin ? ` · pin ${escapeHtml(card.gamma.pin)}` : '';
    if (dealerFlow) lines.push('', `${escapeHtml(dealerFlow)}${pin}`);
    for (const note of Array.isArray(card.gamma.notes) ? card.gamma.notes : []) {
      if (typeof note === 'string' && note) lines.push(`• ${escapeHtml(plainDealerNote(note))}`);
    }
  }
  const theta = thetaText(daysToExpiry(card?.date, card?.expiry));
  if (theta) lines.push('', escapeHtml(theta));

  const live = card?.live;
  const liveFields = [];
  if (Number.isFinite(live?.spot) && live.spot > 0) liveFields.push(`spot ${priceText(live.spot)}`);
  if (Number.isFinite(live?.future) && live.future > 0) liveFields.push(`fut ${priceText(live.future)}`);
  if (Number.isFinite(live?.option) && live.option > 0) {
    const move = Number.isFinite(entry) && entry > 0 ? ((live.option / entry) - 1) * 100 : null;
    const change = Number.isFinite(move) ? ` (${move >= 0 ? '▲ +' : '▼ −'}${Math.abs(move).toFixed(0)}% vs entry)` : '';
    liveFields.push(`opt ₹${priceText(live.option)}${change}`);
  }
  if (liveFields.length) lines.push('', `<b>Live</b> · ${liveFields.join(' · ')}`);
  lines.push('', '🎓 captured-data observation · not advice · final call yours');
  return lines.join('\n');
}

/** Subscriber copy: the same signal, stripped of any model/quality attribution. */
export function observationSubscriberCaption(card) {
  const side = card?.side === 'PE' ? 'PE' : 'CE';
  const symbol = escapeHtml(card?.symbol ?? 'Unknown');
  const strike = Number.isFinite(card?.strike) ? card.strike : '—';
  const expiry = expiryText(card?.date, card?.expiry);
  const price = value => Number.isFinite(value) ? `₹${priceText(value)}` : '—';
  const lines = [
    `📌 <b>${symbol} ${strike}${side}</b>${expiry ? ` · ${escapeHtml(expiry)}` : ''}`,
    `Entry ~${price(card?.entry)} · SL ${price(card?.sl)} · TGT1 ${price(card?.tgt1)} · TGT2 ${price(card?.tgt2)}`,
  ];
  const theta = thetaText(daysToExpiry(card?.date, card?.expiry));
  if (theta) lines.push(escapeHtml(theta));
  lines.push('🎓 captured-data observation · not investment advice · /stop to opt out');
  return lines.join('\n');
}

/** A dependency-free SVG snapshot of the server's Observation card data. */
export function renderObservationCardSvg(card) {
  const bullish = card?.bias !== 'bearish';
  const accent = bullish ? '#16834a' : '#bd3e42';
  const pale = bullish ? '#eaf6ef' : '#fbefef';
  const label = escapeXml(`${card?.symbol ?? 'Unknown'} ${Number.isFinite(card?.strike) ? card.strike : '—'}${card?.side === 'PE' ? 'PE' : 'C'}`);
  const expiry = escapeXml(expiryText(card?.date, card?.expiry) ?? 'Expiry unavailable');
  const time = escapeXml(timeText(card?.at));
  const dealerFlow = dealerFlowText(card?.gamma);
  const pin = dealerFlow && typeof card?.gamma?.pin === 'string' && card.gamma.pin ? ` · pin ${card.gamma.pin}` : '';
  const theta = thetaText(daysToExpiry(card?.date, card?.expiry));
  const quality = Number.isFinite(card?.quality) ? `${(card.quality * 100).toFixed(0)}%` : '—';
  const pickProbability = Number.isFinite(card?.strikePickProbability) ? `${(card.strikePickProbability * 100).toFixed(0)}%` : '—';
  const spot = priceText(card?.spot);
  const spotChange = signedPct(card?.spotChangePct);
  const entry = priceText(card?.entry);
  const stop = priceText(card?.sl);
  const target1 = priceText(card?.tgt1);
  const target2 = priceText(card?.tgt2);
  const support = escapeXml(wallText(card?.support, 'PE'));
  const resistance = escapeXml(wallText(card?.resistance, 'CE'));
  const trail = escapeXml(card?.tsl ?? 'Trailing stop unavailable');
  const disclaimer = escapeXml(card?.disclaimer ?? 'Educational observation; not trade advice.');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="520" viewBox="0 0 760 520" role="img" aria-label="Observation ${label}">
<rect width="760" height="520" rx="22" fill="#f4f5f8"/>
<rect x="20" y="18" width="720" height="484" rx="18" fill="#ffffff" stroke="#dfe2e8"/>
<path d="M38 18h10v484H38a18 18 0 0 1-18-18V36A18 18 0 0 1 38 18Z" fill="${accent}"/>
<text x="72" y="57" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="12" font-weight="700" letter-spacing="2">ORDER FLOW · OBSERVATION</text>
<text x="72" y="99" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="29" font-weight="750">${label}</text>
<text x="72" y="124" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="13">${expiry}${time ? ` · ${time}` : ''}</text>
<rect x="566" y="38" width="144" height="34" rx="17" fill="${pale}"/>
<text x="638" y="60" fill="${accent}" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="12" font-weight="800" letter-spacing="1">${bullish ? 'BULLISH' : 'BEARISH'}</text>
<text x="570" y="101" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="700">Quality ${quality}</text>
<text x="570" y="122" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="11">Strike pick ${pickProbability}</text>
<rect x="68" y="145" width="642" height="54" rx="10" fill="${pale}"/>
<text x="84" y="167" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="10" font-weight="700" letter-spacing="1">UNDERLYING SPOT</text>
<text x="84" y="188" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="19" font-weight="750">${spot}</text>
<text x="700" y="181" fill="${accent}" text-anchor="end" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="750">${spotChange}</text>
<text x="68" y="226" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="10" font-weight="700" letter-spacing="1">PREMIUM PLAN</text>
<g font-family="Inter,Arial,sans-serif">
  <rect x="68" y="238" width="148" height="74" rx="10" fill="#f6f7f9" stroke="#e3e5e9"/>
  <text x="82" y="260" fill="#737887" font-size="10" font-weight="700">ENTRY</text>
  <text x="82" y="290" fill="#171a20" font-size="21" font-weight="750">₹${entry}</text>
  <rect x="230" y="238" width="148" height="74" rx="10" fill="#fbefef" stroke="#f0dddd"/>
  <text x="244" y="260" fill="#9b5052" font-size="10" font-weight="700">STOP · -45%</text>
  <text x="244" y="290" fill="#bd3e42" font-size="21" font-weight="750">₹${stop}</text>
  <rect x="392" y="238" width="148" height="74" rx="10" fill="#eaf6ef" stroke="#d4eadb"/>
  <text x="406" y="260" fill="#477c5a" font-size="10" font-weight="700">TARGET 1 · +55%</text>
  <text x="406" y="290" fill="#16834a" font-size="21" font-weight="750">₹${target1}</text>
  <rect x="554" y="238" width="156" height="74" rx="10" fill="#eaf6ef" stroke="#d4eadb"/>
  <text x="568" y="260" fill="#477c5a" font-size="10" font-weight="700">TARGET 2 · +90%</text>
  <text x="568" y="290" fill="#16834a" font-size="21" font-weight="750">₹${target2}</text>
</g>
<text x="68" y="341" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="10" font-weight="700" letter-spacing="1">OPEN-INTEREST WALLS</text>
<text x="68" y="365" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="650">SUPPORT · ${support}</text>
<text x="68" y="386" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="650">RESISTANCE · ${resistance}</text>
<text x="68" y="414" fill="#737887" font-family="Inter,Arial,sans-serif" font-size="11">${trail}</text>
${dealerFlow ? `<text x="68" y="438" fill="#171a20" font-family="Inter,Arial,sans-serif" font-size="11" font-weight="650">${escapeXml(dealerFlow + pin)}</text>` : ''}
${theta ? `<text x="68" y="461" fill="#80601e" font-family="Inter,Arial,sans-serif" font-size="10">${escapeXml(theta)}</text>` : ''}
<line x1="68" x2="710" y1="478" y2="478" stroke="#e3e5e9"/>
<text x="68" y="496" fill="#777d88" font-family="Inter,Arial,sans-serif" font-size="9">${disclaimer}</text>
</svg>`;
}
