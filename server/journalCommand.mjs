import { signalStatsLines } from './journalStats.mjs';

const DISCLAIMER = '🎓 observation history is educational only · not investment advice';
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatR(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function cardLine(card) {
  const outcome = card.outcome;
  const status = String(outcome.status ?? 'unknown').toUpperCase();
  const target2 = outcome.tgt2 === true ? ' · TGT2' : '';
  return `• <b>${escapeHtml(card.symbol)} ${escapeHtml(card.strike)}${card.side === 'PE' ? 'PE' : 'CE'}</b> · ${escapeHtml(status)} · R${formatR(outcome.r)}${target2}`;
}

/** Render this IST date's persisted observation outcomes without touching journal state. */
export function formatJournalMessage(cards, date) {
  const outcomes = (Array.isArray(cards) ? cards : []).filter(card => card?.date === date && card?.outcome && typeof card.outcome === 'object');
  if (!outcomes.length) return `No outcomes resolved yet today.\n\n${DISCLAIMER}`;

  const count = status => outcomes.filter(card => card.outcome.status === status).length;
  const tally = `${count('tgt1')} TGT1 · ${count('sl')} SL · ${count('open')} open${count('ambiguous') ? ` · ${count('ambiguous')} ambiguous` : ''}`;
  const lines = [`📓 <b>Journal ${escapeHtml(date)}</b>`, `<b>Day tally</b> · ${tally}`];
  // Which card type actually works: early vs model, ORB ✓ vs ✗ (owner P0-1).
  const signalLines = signalStatsLines(outcomes.filter(card => card?.date === date));
  if (signalLines.length) lines.push('', '<b>By signal</b>', ...signalLines);
  const limit = 899 - DISCLAIMER.length - 2;
  for (let index = 0; index < outcomes.length; index++) {
    const line = cardLine(outcomes[index]);
    const remaining = outcomes.length - index - 1;
    const marker = remaining ? `• … ${remaining} more cards` : null;
    if ([...lines, line, ...(marker ? [marker] : [])].join('\n').length <= limit) {
      lines.push(line);
      continue;
    }
    const omitted = outcomes.length - index;
    const truncated = `• … ${omitted} more card${omitted === 1 ? '' : 's'}`;
    if ([...lines, truncated].join('\n').length <= limit) lines.push(truncated);
    break;
  }
  return `${lines.join('\n')}\n\n${DISCLAIMER}`;
}
