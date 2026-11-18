import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateStrikes, chainWalls, chooseChain, orbStrategy, earlyCards, adaptiveLevels, levelsFor, advisorQuestions, advisorDecisions, dedupeObservations, loadObservations, runAdvisor } from './strikeAdvisor.mjs';
import { observationCaption } from './observationCardSvg.mjs';
import { gammaProfile } from '../src/features/market-flow/gammaModel';

const NOW = Date.parse('2026-11-16T05:00:00Z');

afterEach(() => vi.unstubAllEnvs());

function seriesFixture() {
  const rows: number[][] = [];
  // Strikes 290..310 step 5; CE side 0, PE side 1. [strike, side, ltp, prevClose, oi, prevOi, vol]
  for (const strike of [290, 295, 300, 305, 310]) {
    rows.push([strike, 0, 4 + (310 - strike) * 0.5, 5, strike === 310 ? 4_200_000 : 1_000_000, 3_500_000, 100_000]); // CE, 310 = resistance wall
    rows.push([strike, 1, 4 + (strike - 290) * 0.5, 5, strike === 290 ? 3_800_000 : 900_000, 900_000, 90_000]);   // PE, 290 = support wall
  }
  return { s: 'MANAPPURAM', sp: 300.4, pc: 308, atm: 300, e: '2026-11-19', r: rows, date: '2026-11-16' };
}

describe('candidateStrikes', () => {
  it('skips dust strikes and wide spreads, and derives ATR/delta levels', () => {
    const row18 = (strike: number, side: number, ltp: number, bid: number, ask: number, oi: number, volume: number, delta: number) => [
      strike, side, ltp, ltp, oi, oi, volume, 0, ltp, 20, bid, ask, 100, 100, ltp, ltp, null, delta,
    ];
    const series = {
      s: 'TEST', sp: 300, pc: 300, atm: 300, e: '2026-11-19',
      r: [
        row18(300, 0, 10, 1, 20, 500_000, 50_000, 0.5), // wide spread → skipped
        row18(305, 0, 8, 7.95, 8.05, 400_000, 40_000, 0.4), // liquid → candidate
        row18(310, 0, 6, 5.9, 6.1, 5_000, 40_000, 0.3), // OI too thin → skipped
        row18(295, 0, 12, 11.9, 12.1, 400_000, 100, 0.6), // volume too thin → skipped
      ],
    };
    const candidates = candidateStrikes(series, 'bullish');
    expect(candidates.map(item => item.strike)).toEqual([305]);
    expect(candidates[0].delta).toBe(0.4);

    const card = { entry: 50, atr: { value: 100, barMinutes: 15, state: 'normal' }, delta: 0.6 };
    expect(adaptiveLevels(card)).toMatchObject({ sl: 25, tgt1: 140, tgt2: 200, levelsBasis: 'ATR' });
    expect(adaptiveLevels({ entry: 50 })).toMatchObject({ levelsBasis: 'fixed' });
  });

  it('sizes levels on the underlying and prints the stock price each target needs (decay included)', () => {
    const card = {
      symbol: 'IREDA', side: 'CE', strike: 120, spot: 119.8, entry: 2.53, delta: 0.54, iv: 40.4,
      expiry: '2026-11-23', atr: { value: 2.4, barMinutes: 15, state: 'normal' },
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-18T15:30:00+05:30') });
    expect(priced.levelsBasis).toBe('ATR+decay');
    expect(priced.holdDays).toBe(2);
    expect(priced.thetaDay).toBeLessThan(0);
    expect(priced.tgt1).toBeGreaterThan(priced.entry);
    expect(priced.sl).toBeLessThan(priced.entry);
    // A CE target needs the stock ABOVE spot, the stop BELOW it.
    expect(priced.needs.tgt1.level).toBeGreaterThan(119.8);
    expect(priced.needs.sl.level).toBeLessThan(119.8);
    expect(priced.needs.tgt1.pct).toBeGreaterThan(0);
    expect(priced.requiredMovePct).toBeGreaterThan(0);
    // The quoted target and the quoted level agree: pricing that move returns the target.
    expect(priced.tgt1).toBeGreaterThan(2.53);
  });

  it('refuses to quote a premium target when decay eats an ATR-sized move', () => {
    const card = {
      symbol: 'X', side: 'CE', strike: 100, spot: 100, entry: 0.6, delta: 0.2, iv: 60,
      expiry: '2026-11-19', atr: { value: 0.2, barMinutes: 15, state: 'compressed' },
    };
    const priced = adaptiveLevels(card, { holdDays: 2, now: Date.parse('2026-11-18T15:30:00+05:30') });
    expect(priced.levelsBasis).toBe('decay-too-heavy');
    expect(priced.needs).toBeNull();
  });

  it('early cards catch momentum (flat OI) and strong build-ups the model gate skips', () => {
    const rows = (strike: number, mult: number) => [
      [strike, 0, 6, 5, Math.round(100_000 * mult), 100_000, 10_000],
      [strike, 1, 6, 5, Math.round(100_000 * mult), 100_000, 10_000],
    ];
    const market = {
      date: '2026-11-16',
      series: [
        { s: 'UJJIVANSFB', sp: 103.9, pc: 102, atm: 104, e: '2026-11-19', r: [...rows(104, 1), ...rows(105, 1)] },
        { s: 'SAGILITY', sp: 26.3, pc: 25.5, atm: 26, e: '2026-11-19', r: [...rows(26, 1.2), ...rows(27, 1.2)] },
      ],
    };
    const cards = earlyCards(market, '2026-11-16', NOW);
    expect(cards.map(card => card.symbol).sort()).toEqual(['SAGILITY', 'UJJIVANSFB']);
    expect(cards.find(card => card.symbol === 'SAGILITY')?.early).toBe('build-fast');
    expect(cards.find(card => card.symbol === 'UJJIVANSFB')?.early).toBe('momentum');
    expect(cards.every(card => card.side === 'CE' && card.entry > 0.5)).toBe(true);
    expect(earlyCards(market, '2026-11-16', NOW, cards)).toHaveLength(0);
  });

  it('tags a card with the owner ORB playbook at build time', () => {
    const open = Date.parse('2026-11-16T09:15:00+05:30');
    const candles = [0, 1, 2, 3, 4].map(minute => ({
      at: open + minute * 60_000, close: 293 + minute, high: 295, low: 292.5, open: 293,
    }));
    const snapshot = { symbol: 'MANAPPURAM', session: '2026-11-16', months: [{ candles }] };
    const card = { spot: 296, bias: 'bullish', oiChangePct: 11.7 };
    expect(orbStrategy(snapshot, card, NOW)).toMatchObject({ qualifies: true });
    expect(orbStrategy(snapshot, card, NOW).label).toContain('ORB ✓');
    expect(orbStrategy(snapshot, { ...card, spot: 294 }, NOW).label).toContain('no breakout yet');
    expect(orbStrategy(snapshot, { ...card, spot: 307 }, NOW).label).toContain('VWAP');
    expect(orbStrategy(snapshot, { ...card, oiChangePct: 3 }, NOW).label).toContain('<5% needed');
    expect(orbStrategy(snapshot, { ...card, oiChangePct: null }, NOW).label).toContain('unknown');
    const thin = { ...snapshot, months: [{ candles: candles.slice(0, 2) }] };
    // A quiet minute prints no candle: two prints still form the opening range.
    expect(orbStrategy(thin, card, NOW).label).toContain('ORB ✓');
    expect(orbStrategy({ ...snapshot, months: [{ candles: [] }] }, card, NOW).label).toContain('range pending');
    expect(orbStrategy(null, card, NOW)).toBeNull();
  });

  it('switches to the next-expiry block only when the near expiry is inside the DTE threshold', () => {
    const next = { e: '2026-12-31', sp: 300.9, pc: 308.2, atm: 300, r: [[300, 0, 12, 11, 2_000_000, 1_800_000, 50_000]] };
    // Exactly 3 DTE (expiry 15:30 IST − same clock time) → the December block wins.
    const boundary = Date.parse('2026-11-16T15:30:00+05:30');
    const near3 = { ...seriesFixture(), e: '2026-11-19', next };
    const chosen = chooseChain(near3, boundary);
    expect(chosen.e).toBe('2026-12-31');
    expect(chosen.sp).toBe(300.9);
    expect(chosen.r).toEqual(next.r);
    // Past the threshold → today's behaviour (near chain stays).
    const near8 = { ...seriesFixture(), e: '2026-11-24', next };
    expect(chooseChain(near8, NOW).e).toBe('2026-11-24');
    // No next block, or a broken expiry → unchanged.
    expect(chooseChain(seriesFixture(), NOW).e).toBe('2026-11-19');
    expect(chooseChain({ ...seriesFixture(), e: 'not-a-date', next }, NOW).e).toBe('not-a-date');
  });

  it('returns buy-side candidates around ATM on the bias side', () => {
    const series = seriesFixture();
    const bearish = candidateStrikes(series, 'bearish');
    expect(bearish.map(c => c.side)).toEqual([1, 1, 1]);
    expect(bearish[0].strike).toBe(300); // ATM first
    expect(bearish.map(c => c.strike)).toEqual([300, 295, 290]);
    const bullish = candidateStrikes(series, 'bullish');
    expect(bullish.map(c => c.strike)).toEqual([300, 305, 310]);
    expect(bullish.every(c => c.side === 0)).toBe(true);
  });

  it('drops near-zero premium candidates (no lottery strikes)', () => {
    const series = seriesFixture();
    series.r = series.r.map(r => (r[0] === 290 && r[1] === 1 ? [290, 1, 0.1, 5, 3_800_000, 900_000, 1] : r));
    const strikes = candidateStrikes(series, 'bearish').map(c => c.strike);
    expect(strikes).not.toContain(290);
  });

  it('returns nothing without spot/atm', () => {
    expect(candidateStrikes({ sp: null }, 'bullish')).toEqual([]);
  });
});

describe('chainWalls / levelsFor', () => {
  it('finds heaviest CE above spot and PE below spot', () => {
    const walls = chainWalls(seriesFixture());
    expect(walls.resistance?.strike).toBe(310);
    expect(walls.support?.strike).toBe(290);
  });

  it('computes the card numbers from the entry premium only', () => {
    const levels = levelsFor({ ltp: 4 }, chainWalls(seriesFixture()));
    expect(levels.entry).toBe(4);
    expect(levels.sl).toBe(2.2);   // −45%
    expect(levels.tgt1).toBe(6.2); // +55%
    expect(levels.tgt2).toBe(7.6); // +90%
    expect(levels.support?.strike).toBe(290);
    expect(levels.resistance?.strike).toBe(310);
  });
});

describe('advisorQuestions / advisorDecisions', () => {
  const candidates = candidateStrikes(seriesFixture(), 'bearish');
  const watch = { symbol: 'MANAPPURAM', bias: 'bearish', candidates, walls: chainWalls(seriesFixture()), at: NOW, date: '2026-11-16' };

  it('asks one quality Noul and one strike Choice per symbol', () => {
    const questions = advisorQuestions('MANAPPURAM', 'bearish', candidates);
    expect(Object.keys(questions)).toEqual(['quality_MANAPPURAM', 'strike_MANAPPURAM']);
    expect(questions.strike_MANAPPURAM.criteria.c1.strike).toBe(300);
  });

  it('writes a card at quality ≥0.65 with a decisive pick', () => {
    const answers = { quality_MANAPPURAM: { noul: 0.8 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.75, c2: 0.15, c3: 0.1 } } };
    const { cards, skipped } = advisorDecisions([watch], answers);
    expect(skipped).toHaveLength(0);
    expect(cards[0].side).toBe('PE');
    expect(cards[0].strike).toBe(300);
    expect(cards[0].sl).toBeLessThan(cards[0].entry);
    expect(cards[0].tgt2).toBeGreaterThan(cards[0].tgt1);
    expect(cards[0].disclaimer).toMatch(/not trade advice/);
  });

  it('skips on low quality or an indecisive pick', () => {
    const low = advisorDecisions([watch], { quality_MANAPPURAM: { noul: 0.4 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } });
    expect(low.cards).toHaveLength(0);
    const unsure = advisorDecisions([watch], { quality_MANAPPURAM: { noul: 0.9 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.34, c2: 0.33, c3: 0.33 } } });
    expect(unsure.cards).toHaveLength(0);
  });

  it('normalizes a 0-100 quality answer onto the 0-1 gate (P0-S3)', () => {
    const answers = (quality: number) => ({ quality_MANAPPURAM: { noul: quality }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const percent = advisorDecisions([watch], answers(80));
    expect(percent.cards).toHaveLength(1);
    expect(percent.cards[0].quality).toBeCloseTo(0.8, 5);
    expect(advisorDecisions([watch], answers(0.8)).cards).toHaveLength(1);
    const low = advisorDecisions([watch], answers(45));
    expect(low.cards).toHaveLength(0);
    expect(low.skipped[0].reason).toBe('quality 45%');
    expect(advisorDecisions([watch], { quality_MANAPPURAM: { noul: 'n/a' }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.9 } } }).skipped[0].reason).toBe('quality unknown');
  });

  it('uses a stable symbol/session identity across advisor passes', () => {
    const answers = { quality_MANAPPURAM: { noul: 0.8 }, strike_MANAPPURAM: { choice: 'c1', probabilities: { c1: 0.75 } } };
    const first = advisorDecisions([{ ...watch, at: NOW }], answers).cards[0];
    const later = advisorDecisions([{ ...watch, at: NOW + 10 * 60_000 }], answers).cards[0];

    expect(first.id).toBe('MANAPPURAM|2026-11-16');
    expect(later.id).toBe(first.id);
  });
});

describe('observation deduplication', () => {
  it('keeps the first card per symbol/session while allowing another day', () => {
    const latest = { id: 'NIFTY|2026-11-16', symbol: 'NIFTY', date: '2026-11-16', entry: 10 };
    const duplicate = { id: 'NIFTY-1731730000', symbol: 'NIFTY', date: '2026-11-16', entry: 9 };
    const nextDay = { id: 'NIFTY|2026-11-17', symbol: 'NIFTY', date: '2026-11-17', entry: 11 };
    expect(dedupeObservations([latest, duplicate, nextDay])).toEqual([latest, nextDay]);
  });

  it('normalizes duplicate persisted cards on read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-dedupe-'));
    const obsPath = join(dir, 'observations.json');
    try {
      writeFileSync(obsPath, JSON.stringify({ cards: [
        { id: 'new', symbol: 'NIFTY', date: '2026-11-16' },
        { id: 'old', symbol: 'NIFTY', date: '2026-11-16' },
        { id: 'other', symbol: 'SENSEX', date: '2026-11-16' },
      ] }));
      expect(loadObservations(obsPath).map(card => card.id)).toEqual(['new', 'other']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAdvisor gates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const obsPath = join(dir, 'observations.json');
  const prepared = [{ symbol: 'MANAPPURAM', bias: 'bearish', candidates: [{ id: 'c1', strike: 300, side: 1, ltp: 4, oi: 1_000_000, prevOi: 900_000, oiChangePct: 11 }], walls: {}, at: NOW, date: '2026-11-16' }];

  it('skips outside the fire window without asking', async () => {
    const result = await runAdvisor({ date: '2026-11-16', series: [] }, { obsPath, watches: prepared, now: Date.parse('2026-11-16T03:50:00Z'), ask: async () => { throw new Error('must not be called'); } });
    expect(result.skipped).toBe('outside fire window');
  });

  it('surfaces a Jev failure as a skip and keeps the store intact', async () => {
    writeFileSync(obsPath, JSON.stringify({ cards: [{ id: 'old' }] }));
    const result = await runAdvisor({ date: '2026-11-16', series: [seriesFixture()] }, { obsPath, watches: prepared, now: NOW, ask: async () => { throw new Error('HTTP 503'); } });
    expect(result.skipped).toBe('failed');
    expect(loadObservations(obsPath)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends one upgrade note when a model card replaces an early signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-upgrade-'));
    const obsPath = join(dir, 'observations.json');
    writeFileSync(obsPath, JSON.stringify({ cards: [{ id: 'UPGTEST|2026-11-16', symbol: 'UPGTEST', date: '2026-11-16', early: 'momentum', entry: 4, expiry: '2026-11-19' }] }));
    const marketSeries = { ...seriesFixture(), s: 'UPGTEST' };
    const ask = async () => ({ quality_UPGTEST: { noul: 80 }, strike_UPGTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const upgrades: string[] = [];
    const sent: unknown[] = [];
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches: [{ symbol: 'UPGTEST', bias: 'bullish' }],
        now: NOW,
        ask,
        send: async message => { sent.push(message); return { sent: true }; },
        sendUpgrade: async text => { upgrades.push(text); return { sent: true }; },
      });
      expect(result.written).toBe(1);
      // The upgrade replaces the early card in place, so it is not "fresh" — only the note goes out.
      expect(sent).toHaveLength(0);
      expect(upgrades).toHaveLength(1);
      expect(upgrades[0]).toContain('Upgrade · UPGTEST');
      expect(upgrades[0]).toContain('quality 80%');
      expect(loadObservations(obsPath)[0]).toMatchObject({ symbol: 'UPGTEST', quality: 0.8 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates one symbol/session card but sends only one Telegram note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-once-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'DUPTEST' };
    const watches = [{ symbol: 'DUPTEST', bias: 'bullish' }];
    const ask = async () => ({ quality_DUPTEST: { noul: 0.9 }, strike_DUPTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const sent = [];
    try {
      const first = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW, ask, send: async message => { sent.push(message); return { sent: true }; },
      });
      const second = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW + 10 * 60_000, ask, send: async message => { sent.push(message); return { sent: true }; },
      });

      const cards = loadObservations(obsPath);
      expect(first.written).toBe(1);
      expect(second.written).toBe(1);
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe('DUPTEST|2026-11-16');
      expect(cards[0].at).toBe(NOW + 10 * 60_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ symbol: 'DUPTEST', date: '2026-11-16', spot: 300.4, spotChangePct: expect.any(Number) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends the stripped subscriber copy instantly when subscriber ids are given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-sub-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'SUBTEST' };
    const watches = [{ symbol: 'SUBTEST', bias: 'bullish' }];
    const ask = async () => ({ quality_SUBTEST: { noul: 0.9 }, strike_SUBTEST: { choice: 'c1', probabilities: { c1: 0.9 } } });
    const subs: Array<{ text: string; chatId: number }> = [];
    try {
      await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath, watches, now: NOW, ask,
        send: async () => ({ sent: true }),
        subscriberChatIds: [123, 456],
        sendSubscriber: async (text, chatId) => { subs.push({ text, chatId }); return { sent: true }; },
      });
      expect(subs).toHaveLength(2);
      expect(subs[0].chatId).toBe(123);
      expect(subs[0].text).toContain('SUBTEST');
      expect(subs[0].text).not.toMatch(/jev|quality|advisor/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('samples cached live readings immediately before sending without persisting them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-live-'));
    const obsPath = join(dir, 'observations.json');
    const marketSeries = { ...seriesFixture(), s: 'LIVEV2' };
    const watches = [{ symbol: 'LIVEV2', bias: 'bullish' }];
    const events: string[] = [];
    let sentCard: Record<string, unknown> | null = null;

    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [marketSeries] }, {
        obsPath,
        watches,
        now: NOW,
        configured: () => true,
        ask: async () => ({ quality_LIVEV2: { noul: 0.9 }, strike_LIVEV2: { choice: 'c1', probabilities: { c1: 0.9 } } }),
        getLive: card => {
          events.push('live');
          expect(card.symbol).toBe('LIVEV2');
          return { spot: 300.5, future: 301, option: 4.2 };
        },
        send: async card => {
          events.push('send');
          sentCard = card;
          return { sent: true };
        },
      });

      expect(result.written).toBe(1);
      expect(events).toEqual(['live', 'send']);
      expect(sentCard).toMatchObject({ sentAt: NOW, live: { spot: 300.5, future: 301, option: 4.2 } });
      expect(loadObservations(obsPath)[0]).not.toHaveProperty('live');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes gamma fields as Jev state and adds deterministic pin/stop notes to the card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-gamma-'));
    const obsPath = join(dir, 'observations.json');
    const row = (strike: number, side: number, ltp: number, oi: number, prevOi: number) => [
      strike, side, ltp, Math.max(0.1, ltp - 1), oi, prevOi, 5_000, 80, ltp, 20,
    ];
    const series = {
      s: 'NIFTY', sp: 100.4, pc: 99.4, atm: 100, t: NOW, e: '2026-11-17', lot: 50,
      r: [
        row(90, 0, 15, 1_000_000, 900_000), row(90, 1, 1, 1_000_000, 900_000),
        row(95, 0, 10, 1_000_000, 900_000), row(95, 1, 2, 2_000_000, 1_000_000),
        row(100, 0, 5, 1_000_000, 900_000), row(100, 1, 5, 500_000, 400_000),
        row(105, 0, 2, 10_000_000, 8_000_000), row(105, 1, 8, 1_000_000, 900_000),
        row(110, 0, 1, 1_000_000, 900_000), row(110, 1, 12, 1_000_000, 900_000),
      ],
    };
    const expectedProfile = gammaProfile(series, { lot: 50, r: 0.065 });
    const watches = [{ symbol: 'NIFTY', bias: 'bullish' }];
    let jevState: any;
    let sentCard: any;

    try {
      vi.stubEnv('GAMMA_SYMBOLS', 'NIFTY');
      vi.stubEnv('GAMMA_RISK_FREE', '0.065');
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches,
        now: NOW,
        configured: () => true,
        ask: async (state: unknown) => {
          jevState = state;
          return { quality_NIFTY: { noul: 0.9 }, strike_NIFTY: { choice: 'c1', probabilities: { c1: 0.9 } } };
        },
        send: async (value: unknown) => { sentCard = value; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      const firstCandidate = jevState.chain.NIFTY.candidates[0];
      expect(firstCandidate).toMatchObject({ strike: 100, regime: expectedProfile.regime });
      expect(firstCandidate.gexAtStrike).toBeGreaterThan(0);
      expect(firstCandidate.distanceToFlip).toBeTypeOf('number');
      expect(expectedProfile.flipLevel).toBeGreaterThan(95);
      expect(sentCard.gamma).toMatchObject({ regime: expectedProfile.regime, flipLevel: expectedProfile.flipLevel, pin: '100CE' });
      expect(sentCard.gamma.notes).toEqual(expect.arrayContaining([
        expect.stringContaining('Gamma pin zone'),
        expect.stringContaining('Wall-based stop sits beyond the gamma flip'),
      ]));
      expect(loadObservations(obsPath)[0].gamma).toMatchObject({ gexAtStrike: firstCandidate.gexAtStrike, distanceToFlip: firstCandidate.distanceToFlip });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds a futures ATR range line to a card without putting ATR in Jev state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-atr-'));
    const obsPath = join(dir, 'observations.json');
    const now = Date.parse('2026-11-16T09:00:00Z'); // 14:30 IST: after the synthetic bars
    const series = { ...seriesFixture(), s: 'ATRTEST' };
    const candles = Array.from({ length: 20 }, (_, index) => {
      const close = 100 + index;
      return { at: now - (20 - index) * 15 * 60_000, open: close - 0.5, high: close + 2, low: close - 1, close, oi: 1_000 + index };
    });
    let jevState: any;
    let sentCard: any;
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches: [{ symbol: 'ATRTEST', bias: 'bullish' }],
        now,
        configured: () => true,
        ask: async (state: unknown) => {
          jevState = state;
          return { quality_ATRTEST: { noul: 0.9 }, strike_ATRTEST: { choice: 'c1', probabilities: { c1: 0.9 } } };
        },
        readFuturesSnapshot: async (symbol, session) => ({ symbol, session, months: [{ date: '2026-11-26', candles }] }),
        send: async card => { sentCard = card; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      expect(jevState.chain.ATRTEST).not.toHaveProperty('atr');
      expect(sentCard.atr).toMatchObject({ barMinutes: 15, state: expect.stringMatching(/^(compressed|normal|expanded)$/) });
      expect(sentCard.atr.value).toBeGreaterThanOrEqual(0);
      expect(observationCaption(sentCard)).toContain(`Range: Futures ATR(15m) ${sentCard.atr.value.toFixed(2)} pts · ${sentCard.atr.state}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the range line, without blocking the card, when only five bars exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-atr-short-'));
    const obsPath = join(dir, 'observations.json');
    const now = Date.parse('2026-11-16T09:00:00Z');
    const series = { ...seriesFixture(), s: 'SHORTATR' };
    const candles = Array.from({ length: 5 }, (_, index) => {
      const close = 100 + index;
      return { at: now - (5 - index) * 15 * 60_000, open: close - 0.5, high: close + 2, low: close - 1, close };
    });
    let sentCard: any;
    try {
      const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
        obsPath,
        watches: [{ symbol: 'SHORTATR', bias: 'bullish' }],
        now,
        configured: () => true,
        ask: async () => ({ quality_SHORTATR: { noul: 0.9 }, strike_SHORTATR: { choice: 'c1', probabilities: { c1: 0.9 } } }),
        readFuturesSnapshot: (symbol, session) => ({ symbol, session, months: [{ date: '2026-11-26', candles }] }),
        send: async card => { sentCard = card; return { sent: true }; },
      });

      expect(result.written).toBe(1);
      expect(sentCard.atr).toBeNull();
      expect(observationCaption(sentCard)).not.toContain('Futures ATR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an eligible card when futures data is missing, corrupt, cross-symbol, or future-dated', async () => {
    const cases = [
      ['missing', () => null],
      ['corrupt', () => { throw new Error('unavailable'); }],
      ['cross-symbol', () => ({ symbol: 'OTHER', session: '2026-11-16', months: [] })],
      ['future-candle', () => ({ symbol: 'SAFEATR', session: '2026-11-16', months: [{ date: '2026-11-26', candles: [{ at: NOW + 60_000, close: 101 }] }] })],
    ] as const;
    for (const [label, readFuturesSnapshot] of cases) {
      const dir = mkdtempSync(join(tmpdir(), `obs-atr-${label}-`));
      const obsPath = join(dir, 'observations.json');
      const series = { ...seriesFixture(), s: 'SAFEATR' };
      try {
        const result = await runAdvisor({ date: '2026-11-16', series: [series] }, {
          obsPath,
          watches: [{ symbol: 'SAFEATR', bias: 'bullish' }],
          now: NOW,
          configured: () => true,
          ask: async () => ({ quality_SAFEATR: { noul: 0.9 }, strike_SAFEATR: { choice: 'c1', probabilities: { c1: 0.9 } } }),
          readFuturesSnapshot,
          send: async () => ({ sent: true }),
        });
        expect(result.written, label).toBe(1);
        expect(loadObservations(obsPath)[0].atr, label).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
