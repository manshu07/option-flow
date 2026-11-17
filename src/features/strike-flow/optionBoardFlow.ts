import { buildMarketFlow, type FlowWindow, type MarketFlow } from '../market-flow/marketFlowModel';
import type { ContractQuote } from '../options-scanner/contractScanModel';
import type { StrikeFlowPayload } from './feed';

/**
 * The Option Board through Order Flow's own pipeline — no new UI, no new math.
 *
 * Each option contract is presented to `buildMarketFlow` as a small synthetic
 * underlying: its premium timeline (minute, premium, OI) IS a FuturesSeries
 * candle list, so the board's own `readFuturesWindow` produces the window's
 * price/OI change and build-up with the board's own floors and tolerances.
 * The contract's quotes row list carries the whole chain snapshot at the last
 * captured minute, so `heaviestLevels` finds the same PE/CE walls and
 * `oiProfile` the same profile the Order Flow tall tiles draw. What comes out
 * is a regular MarketFlow: Order Flow's FlowDiagram renders it unchanged —
 * same distribution strip, same S-curve and gate, same tiles, same large
 * cards, same popup.
 */

interface ChainSnapshot { spot: number; prevClose: number | null; rows: ContractQuote[] }

/** Per-symbol chain snapshot at the last captured minute: walls, profile and PCR read this. */
function chainSnapshots(flow: StrikeFlowPayload): Map<string, ChainSnapshot> {
  const map = new Map<string, ChainSnapshot>();
  const symbols = flow.symbols ?? [flow.symbol];
  for (const symbol of symbols) {
    const points = flow.spot[symbol];
    const spot = points?.at(-1)?.[1];
    if (spot == null) continue;
    const prevClose = flow.spotPrevClose?.[symbol] ?? null;
    const rows: ContractQuote[] = [];
    for (const contract of Object.values(flow.strikes)) {
      if (contract.symbol !== symbol) continue;
      const last = contract.series.at(-1);
      if (!last) continue;
      const [, ltp, oi, volume] = last;
      if (ltp == null) continue;
      rows.push({
        strike: contract.strike, side: contract.side, ltp,
        prevClose: contract.prevClose, oi: oi ?? 0, prevOi: contract.prevOi,
        volume: volume ?? 0, prevVolumeLots: null, avgPrice: 0, iv: contract.iv ?? last[4] ?? null,
        bid: 0, ask: 0, bidQty: 0, askQty: 0, dayHigh: null, dayLow: null,
        lastTradeAt: null, delta: null,
      });
    }
    map.set(symbol, { spot, prevClose, rows });
  }
  return map;
}

export interface OptionBoardInput {
  /** One payload per underlying (NIFTY, BANKNIFTY, SENSEX, or one F&O stock). */
  payloads: StrikeFlowPayload[];
  window: FlowWindow;
  now: number;
}

/**
 * Merge the per-symbol strike payloads and hand them to Order Flow's own
 * board builder. Every returned stock is one option contract; the board's
 * tiles, large cards, checks and popup are Order Flow's own components.
 */
export function optionBoardFlow({ payloads, window, now }: OptionBoardInput): MarketFlow | null {
  const held = payloads.filter(payload => payload && Object.keys(payload.strikes ?? {}).length > 0);
  if (!held.length) return null;
  const date = held[0].date;

  const series: unknown[] = [];
  const universe: unknown[] = [];
  const futures = new Map<string, unknown>();
  for (const payload of held) {
    const snapshotMap = chainSnapshots(payload);
    for (const contract of Object.values(payload.strikes)) {
      const id = `${contract.symbol}${contract.strike}${contract.side}`;
      if (futures.has(id)) continue;
      const snapshot = snapshotMap.get(contract.symbol);
      const lastCandle = contract.series.at(-1);
      if (!snapshot || !lastCandle) continue;
      const candles = contract.series
        .filter(point => point[1] != null)
        .map(point => ({ at: point[0], close: point[1] as number, oi: point[2] ?? 0 }));
      if (candles.length < 2) continue;
      futures.set(id, {
        symbol: id,
        contractDate: contract.expiry ?? date,
        months: [contract.expiry ?? date],
        prevClose: contract.prevClose,
        prevOi: contract.prevOi,
        candles,
      });
      universe.push({
        symbol: id,
        name: `${contract.symbol} ${contract.strike} ${contract.side}`,
        apiKey: id,
        lot: 1,
        kind: 'stock',
        exch: 'NSE',
        sector: 'option',
      });
      series.push({
        // buildMarketFlow reads the TYPED ContractSeries fields (symbol, spot,
        // quotes…), not the wire file's short keys.
        symbol: id,
        kind: 'stock' as const,
        expiry: contract.expiry ?? date,
        at: lastCandle.at,
        spot: snapshot.spot,
        spotPrevClose: snapshot.prevClose,
        atm: null,
        lot: 1,
        lotSource: 'catalogue' as const,
        quotes: snapshot.rows,
        idle: [],
      });
    }
  }
  if (!series.length) return null;

  const market = { schema: 1, at: now, date, series, minutes: [] };
  return buildMarketFlow(
    market as never,
    futures as never,
    universe as never,
    { option: 'Option contracts' },
    { window, scope: 'all', floorPct: null, named: null, lines: 'all' },
    { now },
  );
}
