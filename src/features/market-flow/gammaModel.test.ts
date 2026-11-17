import { describe, expect, it } from 'vitest';
import { gammaProfile, gammaRiskFreeRate, ivFor, type GammaSeries } from './gammaModel';

const CAPTURE_AT = Date.parse('2026-01-01T15:30:00+05:30');
const EXPIRY = '2027-01-01';

function quote(strike: number, side: 'CE' | 'PE', ltp: number, oi = 10_000, iv = 25) {
  return { strike, side, ltp, oi, iv };
}

function syntheticSeries(quotes: GammaSeries['quotes'], overrides: Partial<GammaSeries> = {}): GammaSeries {
  return { symbol: 'TEST', at: CAPTURE_AT, expiry: EXPIRY, spot: 100, lot: 1, quotes, ...overrides };
}

describe('gamma model data quality and GEX', () => {
  it('skips a premium below intrinsic plus the 2% no-arbitrage buffer', () => {
    const result = gammaProfile(syntheticSeries([quote(80, 'CE', 20, 1000, 25)]), { lot: 1, r: 0 });
    expect(result.strikes).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it('enforces the IV range and inverts an out-of-range feed IV when price supports it', () => {
    const sanePrice = quote(100, 'CE', 9.9476, 1000, 4.9);
    const inverted = gammaProfile(syntheticSeries([sanePrice]), { lot: 1, r: 0 });
    expect(inverted.strikes).toHaveLength(1);
    expect(inverted.strikes[0].ivSource).toBe('inverted');
    expect(inverted.strikes[0].iv).toBeCloseTo(0.25, 2);

    expect(ivFor(100, 100, 100, 1, 0.065, 'CE')).toBeNull(); // implies IV above 150%
    const outside = gammaProfile(syntheticSeries([quote(100, 'CE', 100, 1000, 151)]), { lot: 1, r: 0.065 });
    expect(outside).toMatchObject({ strikes: [], skipped: 1 });
  });

  it('prefers a sane captured IV (raw row index 9 in the schema)', () => {
    const result = gammaProfile(syntheticSeries([quote(100, 'CE', 1.5, 1000, 22.5)]), { lot: 1, r: 0 });
    expect(result.strikes[0]).toMatchObject({ iv: 0.225, ivSource: 'feed' });
  });

  it('has its gamma peak near ATM on a synthetic chain', () => {
    const series = syntheticSeries([
      quote(80, 'CE', 26), quote(90, 'CE', 17), quote(100, 'CE', 10), quote(110, 'CE', 5), quote(120, 'CE', 3),
      quote(80, 'PE', 3), quote(90, 'PE', 5), quote(100, 'PE', 10), quote(110, 'PE', 17), quote(120, 'PE', 26),
    ]);
    const result = gammaProfile(series, { lot: 1, r: 0 });
    const peak = result.strikes.reduce((best, current) => current.gamma > best.gamma ? current : best);
    expect(result.skipped).toBe(0);
    expect(peak.K).toBe(100);
  });

  it('finds the strike where cumulative signed GEX changes sign', () => {
    const result = gammaProfile(syntheticSeries([
      quote(90, 'PE', 12, 100_000, 25),
      quote(100, 'CE', 10, 100_000, 25),
      quote(110, 'CE', 5, 100_000, 25),
    ]), { lot: 1, r: 0 });
    expect(result.flipLevel).toBe(100);
    expect(result.regime).toBe('gamma-long');
    expect(result.totalGex).toBeGreaterThan(0);
  });

  it('uses a real captured NIFTY row as a feed-IV regression fixture', () => {
    const captureAt = 1_794_823_803_000;
    const series: GammaSeries = {
      s: 'NIFTY',
      t: captureAt,
      e: '2026-11-17',
      sp: 25_257.1,
      lot: 50,
      r: [[25_250, 0, 107.7, 94.05, 11_559_080, 4_106_895, 292_978_205, 183_208_155, 108.55, 15.29, 107.7, 108, 2080, 16510, 166, 75.4, null, 0.45407]],
    };
    const result = gammaProfile(series, { lot: 50, r: 0.065 });
    const strike = result.strikes[0];
    const time = Math.max(60 * 60_000, Date.parse('2026-11-17T15:30:00+05:30') - captureAt) / (365 * 24 * 60 * 60_000);
    const sigma = 0.1529;
    const d1 = (Math.log(series.sp! / 25_250) + (0.065 + sigma * sigma / 2) * time) / (sigma * Math.sqrt(time));
    const expectedGamma = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) / (series.sp! * sigma * Math.sqrt(time));

    expect(result.skipped).toBe(0);
    expect(strike).toMatchObject({ K: 25_250, side: 'CE', ivSource: 'feed', oi: 11_559_080 });
    expect(strike.iv).toBeCloseTo(0.1529, 12);
    expect(strike.gamma).toBeCloseTo(expectedGamma, 12);
    expect(strike.gex).toBeCloseTo(expectedGamma * 11_559_080 * series.sp! ** 2 * 0.01, 2);
    expect(gammaRiskFreeRate(undefined)).toBe(0.065);
    expect(gammaRiskFreeRate('0.07')).toBe(0.07);
  });
});
