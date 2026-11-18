import { describe, expect, it } from 'vitest';
import { openingRange, sessionVwap, prevDayLevels, futuresOiPct, lastPrice, touchAt, sectorGate, orbRow, orbMessage, sessionOpenAt, sessionMinute, chainSideOi } from './orbModel.mjs';

const SESSION = '2026-11-16';
const OPEN = Date.parse(`${SESSION}T09:15:00+05:30`);
const minute = n => OPEN + n * 60_000;
const candle = (n, { open, high, low, close, oi = 1_000_000, volume } = {}) => ({ at: minute(n), open, high, low, close, oi, ...(volume == null ? {} : { volume }) });

/** 09:15–09:19 candles building a 99–101 range, opening at 100. */
function rangeCandles() {
  return [
    candle(0, { open: 100, high: 100.6, low: 99.4, close: 100.2, volume: 1_000 }),
    candle(1, { open: 100.2, high: 100.9, low: 99.8, close: 100.5, volume: 1_000 }),
    candle(2, { open: 100.5, high: 101, low: 99.9, close: 100.4, volume: 2_000 }),
    candle(3, { open: 100.4, high: 100.8, low: 99.6, close: 99.8, volume: 1_000 }),
    candle(4, { open: 99.8, high: 100.3, low: 99, close: 100, volume: 1_000 }),
  ];
}

describe('opening range / volume / levels', () => {
  it('builds the 09:15–09:20 range and stays null before 09:20', () => {
    const candles = rangeCandles();
    expect(openingRange(candles, SESSION, { now: minute(5) })).toMatchObject({ high: 101, low: 99, open: 100, close: 100, candles: 5 });
    expect(openingRange(candles, SESSION, { now: minute(4) })).toBeNull();
    // Illiquid futures print no candle in a quiet minute — a 2-minute window still forms a range.
    expect(openingRange(candles.slice(0, 2), SESSION, { now: minute(30) })).toMatchObject({ high: 100.9, low: 99.4, candles: 2 });
    expect(openingRange([], SESSION, { now: minute(30) })).toBeNull();
    expect(sessionOpenAt(SESSION)).toBe(OPEN);
    expect(sessionMinute(minute(30), SESSION)).toBe(9 * 60 + 45);
  });

  it('computes session VWAP from volume and refuses to invent one without it', () => {
    const vwap = sessionVwap(rangeCandles(), SESSION);
    const expected = rangeCandles().reduce((sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume, 0) / 6_000;
    expect(vwap).toBeCloseTo(expected, 6);
    expect(sessionVwap(rangeCandles().map(({ volume, ...rest }) => rest), SESSION)).toBeNull();
  });

  it('reads PDH/PDL and OI change from the futures snapshot month', () => {
    expect(prevDayLevels({ prevHigh: 104.5, prevLow: 97.25 })).toEqual({ pdh: 104.5, pdl: 97.25 });
    expect(prevDayLevels({})).toEqual({ pdh: null, pdl: null });
    expect(futuresOiPct({ prevOi: 1_000_000, candles: [candle(0, { open: 100, high: 100, low: 100, close: 100, oi: 1_100_000 })] })).toBeCloseTo(10, 6);
    expect(futuresOiPct({ prevOi: null, candles: [] })).toBeNull();
    expect(lastPrice([...rangeCandles(), candle(5, { open: 101, high: 102, low: 100, close: 101.5 })], minute(6))).toBe(101.5);
    expect(touchAt([...rangeCandles(), candle(6, { open: 101, high: 101.5, low: 100.1, close: 100.4 })], 100.3, { from: minute(5), until: minute(7) })).toBe(minute(6));
  });

  it('gates on sector only when a leading sector is known', () => {
    expect(sectorGate('banks-private', ['banks-private', 'power-utilities'])).toBe('aligned');
    expect(sectorGate('fmcg-consumer', ['banks-private'])).toBe('against');
    expect(sectorGate(null, ['banks-private'])).toBe('neutral');
    expect(sectorGate('banks-private', [])).toBe('neutral');
  });
});

describe('orbRow state machine', () => {
  const base = { symbol: 'MANAPPURAM', session: SESSION, sector: 'nbfc', leadingSectors: ['nbfc'] };

  it('is building before 09:20', () => {
    const row = orbRow({ ...base, candles: rangeCandles(), now: minute(3) });
    expect(row.state).toBe('building');
    expect(row.label).toContain('09:20 candle');
  });

  it('arms inside the range, then qualifies a breakout with OI ≥ 5%', () => {
    const inside = orbRow({ ...base, candles: [...rangeCandles(), candle(10, { open: 100, high: 100.7, low: 99.5, close: 100.6 })], now: minute(12), prevOi: 1_000_000 });
    expect(inside.state).toBe('armed');
    expect(inside.qualifies).toBe(false);
    expect(inside.label).toContain('99–101');

    const broke = orbRow({ ...base, candles: [...rangeCandles(), candle(16, { open: 100.9, high: 101.8, low: 100.8, close: 101.6, oi: 1_080_000 })], now: minute(18), prevOi: 1_000_000 });
    expect(broke.state).toBe('broken-out');
    expect(broke.qualifies).toBe(true);
    expect(broke.brokeLevel).toBe(101);
    expect(broke.oiPct).toBe(8);
    expect(broke.label).toContain('broke 101');
    expect(broke.label).toContain('stop zone 99');
  });

  it('keeps a breakout unqualified while OI lags after 09:30, and soft before it', () => {
    const weak = orbRow({ ...base, candles: [...rangeCandles(), candle(16, { open: 100.9, high: 101.8, low: 100.8, close: 101.6, oi: 900_000 })], now: minute(18), prevOi: 1_000_000 });
    expect(weak.state).toBe('broken-out');
    expect(weak.qualifies).toBe(false);
    expect(weak.blockers.join(' ')).toContain('OI −10.0% < 5%');

    const soft = orbRow({ ...base, candles: [...rangeCandles(), candle(6, { open: 100.9, high: 101.8, low: 100.8, close: 101.6, oi: 900_000 })], now: minute(8), prevOi: 1_000_000 });
    expect(soft.state).toBe('broken-out');
    expect(soft.qualifies).toBe(true);
  });

  it('refuses to chase a ±4% opener and waits for a VWAP touch', () => {
    const strong = [
      candle(0, { open: 100, high: 102, low: 99.8, close: 101.5, oi: 1_050_000, volume: 5_000 }),
      candle(1, { open: 101.5, high: 104, low: 101.2, close: 103.5, oi: 1_060_000, volume: 5_000 }),
      candle(2, { open: 103.5, high: 105, low: 103, close: 104.6, oi: 1_070_000, volume: 5_000 }),
      candle(3, { open: 104.6, high: 105.2, low: 104, close: 104.8, oi: 1_075_000, volume: 5_000 }),
      candle(4, { open: 104.8, high: 105.4, low: 104.2, close: 105, oi: 1_080_000, volume: 5_000 }),
      candle(10, { open: 105, high: 105.6, low: 104.4, close: 105.2, oi: 1_090_000, volume: 5_000 }),
    ];
    const waiting = orbRow({ ...base, candles: strong, now: minute(12), prevOi: 1_000_000 });
    expect(waiting.state).toBe('extended-wait');
    expect(waiting.qualifies).toBe(false);
    expect(waiting.openMovePct).toBe(5);
    expect(waiting.label).toContain('wait for a VWAP touch');

    const vwap = waiting.vwap;
    const dip = [...strong, candle(14, { open: 105.2, high: 105.3, low: vwap - 0.5, close: vwap, oi: 1_095_000, volume: 5_000 })];
    const touched = orbRow({ ...base, candles: dip, now: minute(16), prevOi: 1_000_000 });
    expect(touched.state).toBe('entered-zone');
    expect(touched.qualifies).toBe(true);
    expect(touched.label).toContain('VWAP');
  });

  it('marks a downside break as its own direction, not "inside the range"', () => {
    const row = orbRow({ ...base, candles: [...rangeCandles(), candle(30, { open: 97, high: 97.4, low: 96, close: 96.5, oi: 1_120_000 })], now: minute(32), prevOi: 1_000_000 });
    expect(row.state).toBe('broken-out');
    expect(row.direction).toBe('down');
    expect(row.brokeLevel).toBe(99);
    expect(row.stopZone).toBe(101);
    expect(row.qualifies).toBe(true);
    expect(row.label).toContain('broke 99 down');
  });

  it('confirms a downside break with the PE side when futures OI unwinds', () => {
    const down = [...rangeCandles(), candle(30, { open: 97, high: 97.4, low: 96, close: 96.5, oi: 900_000 })];
    const chainOi = { ce: -6.2, pe: 7.4 };
    const row = orbRow({ ...base, candles: down, now: minute(32), prevOi: 1_000_000, chainOi });
    expect(row.direction).toBe('down');
    expect(row.oiSource).toBe('chain-pe');
    expect(row.oiPct).toBe(7.4);
    expect(row.qualifies).toBe(true);
    expect(row.label).toContain('PE OI +7.4%');

    const weak = orbRow({ ...base, candles: down, now: minute(32), prevOi: 1_000_000, chainOi: { ce: 6, pe: 2.1 } });
    expect(weak.qualifies).toBe(false);
    expect(weak.blockers.join(' ')).toContain('PE OI +2.1% < 5%');
  });

  it('reads side OI totals from the chain rows, ignoring legs without a baseline', () => {
    expect(chainSideOi([
      [100, 0, 5, 5, 1_000, 800, 10], // CE oi 1000 vs 800
      [100, 1, 5, 5, 900, 1_000, 10], // PE oi 900 vs 1000
      [105, 0, 2, 2, 500, null, 10], // no baseline → ignored
    ])).toEqual({ ce: 25, pe: -10 });
    expect(chainSideOi([])).toEqual({ ce: null, pe: null });
  });

  it('marks a non-leading sector as a blocker instead of a silent pass', () => {
    const row = orbRow({ ...base, sector: 'fmcg-consumer', leadingSectors: ['banks-private'], candles: [...rangeCandles(), candle(16, { open: 100.9, high: 101.8, low: 100.8, close: 101.6, oi: 1_100_000 })], now: minute(18), prevOi: 1_000_000 });
    expect(row.state).toBe('broken-out');
    expect(row.sectorState).toBe('against');
    expect(row.qualifies).toBe(false);
    expect(row.blockers.join(' ')).toContain('not leading');
  });
});

describe('orbMessage', () => {
  it('says so once when nothing qualifies, and lists breakouts + extended openers otherwise', () => {
    const empty = orbMessage([{ symbol: 'ITC', state: 'armed', qualifies: false }], { slot: '09:35', date: SESSION });
    expect(empty).toContain('ORB 09:35');
    expect(empty).toContain('No qualified breakouts today.');

    const rows = [
      { symbol: 'ITC', state: 'broken-out', qualifies: true, price: 295.4, brokeLevel: 295, oiPct: 11.7, rangeLow: 292.5, rangeHigh: 295 },
      { symbol: 'IEX', state: 'extended-wait', qualifies: false, price: 148.2, openMovePct: 4.6 },
      { symbol: 'SAIL', state: 'broken-out', qualifies: false, blockers: ['OI +2.1% < 5%'], price: 118 },
    ];
    const text = orbMessage(rows, { slot: '10:05', date: SESSION });
    expect(text).toContain('ORB 10:05');
    expect(text).toContain('ITC 295.4 — broke 295, OI +11.7%, range 292.5–295');
    expect(text).toContain('Extended openers');
    expect(text).toContain('IEX 148.2 — opened +4.6%');
    expect(text).toContain('SAIL — OI +2.1% < 5%');
    expect(text).toContain('not trade advice');
  });
});