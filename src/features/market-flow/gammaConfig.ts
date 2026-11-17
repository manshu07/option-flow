import { gammaRiskFreeRate } from './gammaModel';

export const DEFAULT_GAMMA_SYMBOLS = ['NIFTY', 'BANKNIFTY'] as const;

/** Symbols are configurable without code changes; invalid names are ignored. */
export function parseGammaSymbols(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') return [...DEFAULT_GAMMA_SYMBOLS];
  const symbols = [...new Set(value.split(',').map(symbol => symbol.trim().toUpperCase())
    .filter(symbol => /^[A-Z0-9&._-]{1,40}$/.test(symbol)))];
  return symbols.length ? symbols : [...DEFAULT_GAMMA_SYMBOLS];
}

/** SENSEX is omitted from defaults because Dhan's captured BSE chain is empty. */
export const GAMMA_SYMBOLS = parseGammaSymbols(typeof __GAMMA_SYMBOLS__ === 'string' ? __GAMMA_SYMBOLS__ : undefined);
export const GAMMA_RISK_FREE = gammaRiskFreeRate(typeof __GAMMA_RISK_FREE__ === 'string' ? __GAMMA_RISK_FREE__ : undefined);
