export const REPLAY_DATE = '2026-10-30';

const epoch = (hhmm: string) => {
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2));
  return Date.parse(`${REPLAY_DATE}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
};

export const CAPTURED_MINUTES = ['0915', '0930', '1000', '1445', '1447', '1450', '1530'];
export const GAP_MINUTE = '0945';

/** A deterministic schema-1 market file, using the app's recorded-session encoding. */
export function marketSnapshot(hhmm: string, close: number) {
  return {
    schema: 1,
    t: epoch(hhmm),
    date: REPLAY_DATE,
    series: [
      {
        s: 'RELIANCE', k: 'stock', e: '2026-11-24', lot: 500, ls: 'catalogue',
        t: epoch(hhmm), tp: epoch(hhmm), sp: close, pc: 995, atm: 1000,
        r: [[1000, 0, 10, 9, 5000, 4900, 100, 90, 10, null, 9.9, 10.1, 10, 10, 12, 8, epoch(hhmm), null]],
        ks: [1000], z: [],
      },
      {
        s: 'NIFTY', k: 'index', e: '2026-11-24', lot: 50, ls: 'catalogue',
        t: epoch(hhmm), tp: epoch(hhmm), sp: close * 2, pc: 1990, atm: 2000,
        r: [[2000, 0, 20, 18, 5000, 4900, 100, 90, 20, null, 19.9, 20.1, 10, 10, 22, 18, epoch(hhmm), null]],
        ks: [2000], z: [],
      },
    ],
    minutes: CAPTURED_MINUTES.map(minute => [minute, epoch(minute)]),
    ladders: { RELIANCE: ['2026-11-24'] },
  };
}

export const MARKET_BY_MINUTE = Object.fromEntries(
  ([
    ['0915', 1000], ['0930', 1005], ['1000', 1010], ['1445', 1045], ['1447', 1047], ['1450', 1050], ['1530', 1060],
  ] as Array<[string, number]>).map(([minute, close]) => [minute, marketSnapshot(minute, close)]),
);

export const MANIFEST = {
  provider: { id: 'recorded', label: 'Recorded 30 Oct 2026' },
  date: REPLAY_DATE,
  minutes: CAPTURED_MINUTES.map(minute => [minute, epoch(minute)]),
  start: epoch('0915'),
  end: epoch('1530'),
  futures: {
    RELIANCE: { available: true, months: ['2026-11-24'], firstAt: epoch('0915'), lastAt: epoch('1530'), start: epoch('0915'), end: epoch('1530') },
    NIFTY: { available: false, months: [], firstAt: null, lastAt: null, start: null, end: null },
  },
};

/** Futures include a later candle so the 14:47 request can prove no look-ahead. */
export const FUTURES_BY_AS_OF = {
  '1447': {
    symbol: 'RELIANCE',
    session: REPLAY_DATE,
    months: [{
      date: '2026-11-24', prevClose: 995, prevOi: 1_000_000,
      candles: [
        { at: epoch('1445'), close: 1045, oi: 1_004_500 },
      ],
    }],
  },
};

export const FUTURES_AFTER_AS_OF = {
  symbol: 'RELIANCE',
  session: REPLAY_DATE,
  months: [{
    date: '2026-11-24', prevClose: 995, prevOi: 1_000_000,
    candles: [
      { at: epoch('1445'), close: 1045, oi: 1_004_500 },
      { at: epoch('1447'), close: 1047, oi: 1_004_700 },
      { at: epoch('1450'), close: 1050, oi: 1_005_000 },
    ],
  }],
};

export const fixtureEpoch = epoch;
