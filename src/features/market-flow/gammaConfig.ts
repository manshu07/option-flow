import { gammaRiskFreeRate, parseGammaSymbols } from './gammaModel';

export { DEFAULT_GAMMA_SYMBOLS, parseGammaSymbols } from './gammaModel';

/** SENSEX is omitted from defaults because Dhan's captured BSE chain is empty. */
export const GAMMA_SYMBOLS = parseGammaSymbols(typeof __GAMMA_SYMBOLS__ === 'string' ? __GAMMA_SYMBOLS__ : undefined);
export const GAMMA_RISK_FREE = gammaRiskFreeRate(typeof __GAMMA_RISK_FREE__ === 'string' ? __GAMMA_RISK_FREE__ : undefined);
