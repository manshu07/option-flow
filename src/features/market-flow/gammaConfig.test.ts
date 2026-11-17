import { describe, expect, it } from 'vitest';
import { DEFAULT_GAMMA_SYMBOLS, parseGammaSymbols } from './gammaConfig';

describe('GAMMA_SYMBOLS configuration', () => {
  it('defaults to NIFTY and BANKNIFTY', () => {
    expect(parseGammaSymbols(undefined)).toEqual(['NIFTY', 'BANKNIFTY']);
    expect(parseGammaSymbols('')).toEqual(DEFAULT_GAMMA_SYMBOLS);
  });

  it('normalizes, deduplicates, and allows widening by environment value', () => {
    expect(parseGammaSymbols(' nifty, BANKNIFTY, nifty, RELIANCE ')).toEqual(['NIFTY', 'BANKNIFTY', 'RELIANCE']);
    expect(parseGammaSymbols('SENSEX')).toEqual(['SENSEX']);
  });

  it('falls back to defaults when no valid symbol is configured', () => {
    expect(parseGammaSymbols('###, , !!!')).toEqual(['NIFTY', 'BANKNIFTY']);
  });
});
