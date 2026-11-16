import { describe, expect, it } from 'vitest';
import { formatJournalMessage } from './journalCommand.mjs';

const TODAY = '2026-11-16';

describe('/journal message', () => {
  it('returns a clear empty-state reply with the disclaimer', () => {
    const text = formatJournalMessage([], TODAY);
    expect(text).toContain('No outcomes resolved yet today.');
    expect(text).toContain('not investment advice');
  });

  it('lists today outcomes and tally while excluding other dates', () => {
    const text = formatJournalMessage([
      { date: TODAY, symbol: 'TMPV', strike: 265, side: 'PE', outcome: { status: 'tgt1', r: 1.22, tgt2: true } },
      { date: TODAY, symbol: 'BANKNIFTY', strike: 61600, side: 'CE', outcome: { status: 'sl', r: -1 } },
      { date: TODAY, symbol: 'MANAPPURAM', strike: 305, side: 'PE', outcome: { status: 'open', r: null } },
      { date: TODAY, symbol: 'NIFTY', strike: 25000, side: 'CE', outcome: { status: 'ambiguous', r: -1 } },
      { date: '2026-11-17', symbol: 'TOMORROW', strike: 100, side: 'CE', outcome: { status: 'tgt1', r: 2 } },
    ], TODAY);

    expect(text).toContain('1 TGT1 · 1 SL · 1 open · 1 ambiguous');
    expect(text).toContain('<b>TMPV 265PE</b> · TGT1 · R+1.22 · TGT2');
    expect(text).toContain('<b>BANKNIFTY 61600CE</b> · SL · R−1.00');
    expect(text).toContain('<b>MANAPPURAM 305PE</b> · OPEN · R—');
    expect(text).not.toContain('TOMORROW');
    expect(text).toContain('not investment advice');
  });

  it('escapes symbols and stays under the Telegram message limit', () => {
    const cards = Array.from({ length: 50 }, (_, index) => ({
      date: TODAY,
      symbol: index === 0 ? '<TMPV&>' : `SYM${index}`,
      strike: 100 + index,
      side: 'CE',
      outcome: { status: 'tgt1', r: 1.22 },
    }));

    const text = formatJournalMessage(cards, TODAY);

    expect(text).toContain('&lt;TMPV&amp;&gt;');
    expect(text).not.toContain('<TMPV&>');
    expect(text).toContain('more cards');
    expect(text.length).toBeLessThan(900);
  });
});
