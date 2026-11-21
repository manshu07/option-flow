import { describe, expect, it } from 'vitest';
import { istMinuteOfDay, orbSlotDue, loadSectorMap, leadingSectors, orbScan, ORB_SLOTS } from './orb.mjs';
import { sectorMapFromUnderlyings } from './orbModel.mjs';

const SESSION = '2026-11-16';
const OPEN = Date.parse(`${SESSION}T09:15:00+05:30`);
const minute = n => OPEN + n * 60_000;

describe('push schedule', () => {
  it('knows IST minutes and fires each slot once inside its window', () => {
    expect(istMinuteOfDay(Date.parse('2026-11-16T09:35:00+05:30'))).toBe(575);
    expect(istMinuteOfDay(Date.parse('2026-11-16T00:05:00+05:30'))).toBe(5);

    const sent = new Set();
    expect(orbSlotDue(Date.parse('2026-11-16T09:34:00+05:30'), sent)).toBeNull();
    expect(orbSlotDue(Date.parse('2026-11-16T09:36:00+05:30'), sent)).toBe('09:35');
    sent.add('09:35');
    expect(orbSlotDue(Date.parse('2026-11-16T09:37:00+05:30'), sent)).toBeNull();
    expect(orbSlotDue(Date.parse('2026-11-16T10:06:00+05:30'), sent)).toBe('10:05');
    sent.add('10:05');
    expect(orbSlotDue(Date.parse('2026-11-16T11:30:00+05:30'), sent)).toBeNull();
    expect(ORB_SLOTS.map(slot => slot.key)).toEqual(['09:35', '10:05']);
  });
});

describe('sector wiring', () => {
  it('reads symbol sectors from underlyings.json', () => {
    const read = () => JSON.stringify({ underlyings: [{ symbol: 'ITC', sector: 'fmcg-consumer' }, { symbol: 'HDFCBANK', sector: 'banks-private' }, { symbol: 'X' }] });
    const map = loadSectorMap('/fake/underlyings.json', read);
    expect(map.get('ITC')).toBe('fmcg-consumer');
    expect(map.has('X')).toBe(false);
    expect(loadSectorMap('/fake', () => 'not json').size).toBe(0);
  });

  it('builds the canonical ORB/advisor sector map from the catalog rows', () => {
    const map = sectorMapFromUnderlyings([
      { symbol: 'ITC', sector: 'fmcg-consumer' },
      { symbol: 'X', sector: '' },
      { symbol: 'missing-sector' },
      null,
    ]);
    expect([...map]).toEqual([['ITC', 'fmcg-consumer']]);
  });

  it('derives leading sectors from the day\'s strongest movers', () => {
    const sectors = new Map([['ITC', 'fmcg-consumer'], ['HDFCBANK', 'banks-private'], ['IEX', 'power-utilities'], ['SAIL', 'metals']]);
    const series = [
      { s: 'ITC', sp: 110, pc: 100 }, // +10%
      { s: 'HDFCBANK', sp: 180, pc: 200 }, // −10%
      { s: 'IEX', sp: 101, pc: 100 }, // +1% — below the floor
      { s: 'SAIL', sp: 104, pc: 100 }, // +4%
    ];
    expect(leadingSectors(series, sectors)).toEqual(['fmcg-consumer', 'banks-private', 'metals']);
    expect(leadingSectors([], sectors)).toEqual([]);
  });
});

describe('orbScan', () => {
  const range = [0, 1, 2, 3, 4].map(n => ({ at: minute(n), open: 100, high: 101, low: 99, close: 100, oi: 1_000_000 }));
  const snapshot = (symbol, candles, prevOi = 1_000_000) => ({ symbol, session: SESSION, months: [{ date: '2026-11-20', prevOi, prevHigh: 104, prevLow: 97, candles }] });

  it('ranks qualified breakouts first and reports counts', () => {
    const series = [{ s: 'ITC', sp: 110, pc: 100 }, { s: 'SAIL', sp: 104, pc: 100 }, { s: 'IEX', sp: 100.5, pc: 100 }];
    const snapshots = new Map([
      ['ITC', snapshot('ITC', [...range, { at: minute(20), open: 101, high: 102.5, low: 100.9, close: 102, oi: 1_120_000 }])],
      ['SAIL', snapshot('SAIL', [...range, { at: minute(20), open: 100.4, high: 100.8, low: 99.9, close: 100.5, oi: 1_010_000 }])],
      ['IEX', null],
    ]);
    const sectors = new Map([['ITC', 'fmcg-consumer'], ['SAIL', 'metals'], ['IEX', 'power-utilities']]);
    const scan = orbScan({ session: SESSION, now: minute(25), series, readSnapshot: symbol => snapshots.get(symbol) ?? null, sectors });

    expect(scan.rows).toHaveLength(3);
    expect(scan.rows[0].symbol).toBe('ITC');
    expect(scan.rows[0].qualifies).toBe(true);
    expect(scan.rows[0].pdh).toBe(104);
    expect(scan.rows[0].pdl).toBe(97);
    expect(scan.rows[1].symbol).toBe('SAIL');
    expect(scan.rows[1].state).toBe('armed');
    expect(scan.rows[2].symbol).toBe('IEX');
    expect(scan.rows[2].state).toBe('building');
    expect(scan.counts).toMatchObject({ scanned: 3, breakouts: 1, armed: 1, building: 1 });
    expect(scan.leading).toEqual(['fmcg-consumer', 'metals']); // IEX moved +0.5% — below the 1% floor
  });

  it('survives a snapshot reader that throws', () => {
    const scan = orbScan({ session: SESSION, now: minute(30), series: [{ s: 'ITC', sp: 110, pc: 100 }], readSnapshot: () => { throw new Error('boom'); } });
    expect(scan.rows[0].state).toBe('building');
    expect(scan.counts.scanned).toBe(1);
  });
});
