import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { FlowBoard, type FlowLayout } from '../market-flow/FlowBoard';
import { useFitScrollerHeight } from '@/hooks/useFitScrollerHeight';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { applyTheme } from '@/lib/applyTheme';
import { getLatestTradingSessionDate } from '@/lib/marketSession';
import type { Underlying } from '@/lib/underlyings';
import { clockOf, type FlowWindow } from '../market-flow/marketFlowModel';
import { gammaProfile, type GammaSeries } from '../market-flow/gammaModel';
import { GAMMA_RISK_FREE, GAMMA_SYMBOLS } from '../market-flow/gammaConfig';
import { fetchStrikeFlows, type StrikeFlowPayload } from './feed';
import { optionBoardFlow } from './optionBoardFlow';
import { GammaOverlay, GammaRegimeChips, type GammaProfileView } from './GammaOverlay';
import '@/styles/oi-design-tokens.css';
import '../market-flow/market-flow.css';
import '../underlying/pages-finish.css';
import './strike-flow.css';

interface StrikeFlowPageProps {
  universe: Underlying[];
  /** The app's Order Flow / Option Board capsule, rendered inside this page's bar row. */
  tabs?: ReactNode;
}

const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const SCOPES: CapsuleOption<string>[] = [
  { value: 'all-indices', label: 'All 3 Indices' },
  ...INDEX_SYMBOLS.map(symbol => ({ value: symbol, label: symbol === 'NIFTY' ? 'Nifty' : symbol === 'BANKNIFTY' ? 'BankNifty' : 'Sensex' })),
  { value: 'fno-stocks', label: 'F&O Stock Options' },
];
const SUB_TABS: CapsuleOption<'option-board' | 'contracts-screener'>[] = [
  { value: 'option-board', label: 'Option Board' },
  { value: 'contracts-screener', label: 'Contracts Screener' },
];
const MODES: CapsuleOption<'all' | 'CE' | 'PE'>[] = [
  { value: 'all', label: 'Momentum Flow' },
  { value: 'CE', label: 'Calls (Top)' },
  { value: 'PE', label: 'Put (Top)' },
];

function StatusLine({ board, unavailableSymbols = [] }: { board: ReturnType<typeof optionBoardFlow>; unavailableSymbols?: string[] }) {
  if (!board) return <div className="strike-flow__status mf-status" role="status">Reading the captured chain…</div>;
  const up = board.bullish.length;
  const down = board.bearish.length;
  const flat = board.rangebound.length;
  const spotAt = board.futures.latestAt;
  return (
    <div className="strike-flow__status mf-status" role="status" aria-live="polite">
      <span><b className="is-up">{up} up</b> · <b className="is-flat">{flat} flat</b> · <b className="is-down">{down} down</b> of {board.stocks.length}</span>
      {unavailableSymbols.length > 0 && <span className="strike-flow__partial">Partial chain · unavailable: {unavailableSymbols.join(', ')}</span>}
      <span className="strike-flow__status-time">As of {board.date} {clockOf(board.asOf)} · spot to {spotAt == null ? '—' : clockOf(spotAt)}</span>
    </div>
  );
}

export function StrikeFlowPage({ universe, tabs }: StrikeFlowPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const wider = useMediaQuery('(min-width: 1280px)');
  const wide = useMediaQuery('(min-width: 1100px)');
  const phone = useMediaQuery('(max-width: 768px)');
  const layout: FlowLayout = wider ? 'diagram' : wide ? 'desktop' : phone ? 'phone' : 'tablet';
  const fits = layout === 'desktop' || layout === 'diagram';
  const [scope, setScope] = useState('all-indices');
  const [stock, setStock] = useState('');
  // The board reads the day window, exactly like Order Flow's own board.
  const window: FlowWindow = 'day';
  const [side, setSide] = useState<'all' | 'CE' | 'PE'>('all');
  const [subTab, setSubTab] = useState<'option-board' | 'contracts-screener'>('option-board');
  const [date] = useState(() => getLatestTradingSessionDate());
  const stocks = universe.filter(item => item.kind === 'stock').slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  const [payloads, setPayloads] = useState<StrikeFlowPayload[] | null>(null);
  const [unavailableSymbols, setUnavailableSymbols] = useState<string[]>([]);
  const [failedSymbols, setFailedSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const forceNextFetch = useRef(false);

  // Stable identity: a fresh array here would re-trigger the fetch loop every render.
  const activeStock = stock || stocks[0]?.symbol || '';
  const stockScope = scope === 'fno-stocks' ? activeStock : '';
  const symbols = useMemo(() => {
    if (scope === 'all-indices') return [...INDEX_SYMBOLS];
    if (scope === 'fno-stocks') return stockScope ? [stockScope] : [];
    return [scope];
  }, [scope, stockScope]);
  useFitScrollerHeight(pageRef, fits);

  useEffect(() => {
    const controller = new AbortController();
    const force = forceNextFetch.current;
    forceNextFetch.current = false;
    setPayloads(null);
    setUnavailableSymbols([]);
    setFailedSymbols([]);
    setLoading(true);
    setFailed(false);
    void fetchStrikeFlows(symbols, { date, signal: controller.signal, force }).then(result => {
        if (controller.signal.aborted) return;
        const kept = result.payloads.filter(payload => Object.keys(payload.strikes).length > 0);
        setPayloads(kept);
        setUnavailableSymbols(result.unavailableSymbols);
        setFailedSymbols(result.failedSymbols);
        setFailed(kept.length === 0 && result.failedSymbols.length > 0);
        setLoading(false);
      }).catch(() => {
        if (controller.signal.aborted) return;
        setFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [scope, date, retry, symbols]);

  const board = useMemo(
    () => (payloads && payloads.length ? optionBoardFlow({ payloads, window, now: Date.now() }) : null),
    [payloads, window],
  );
  const viewed = useMemo(() => {
    if (!board) return null;
    if (side === 'all') return board;
    const keep = (stock: { side: string | null; symbol: string }) => stock.side === null || (side === 'CE' ? stock.symbol.endsWith('CE') : stock.symbol.endsWith('PE'));
    return {
      ...board,
      stocks: board.stocks.filter(keep),
      bullish: board.bullish.filter(stock => keep(stock)),
      bearish: board.bearish.filter(stock => keep(stock)),
      rangebound: board.rangebound.filter(stock => keep(stock)),
      unread: board.unread.filter(stock => keep(stock)),
    };
  }, [board, side]);
  const gammaProfiles = useMemo(() => {
    const allowed = new Set(GAMMA_SYMBOLS);
    const seen = new Set<string>();
    const output: GammaProfileView[] = [];
    for (const payload of payloads ?? []) {
      const symbol = payload.symbol;
      if (!allowed.has(symbol) || seen.has(symbol)) continue;
      const spotPoint = payload.spot[symbol]?.at(-1);
      const contracts = Object.values(payload.strikes).filter(contract => contract.symbol === symbol);
      if (!spotPoint || !contracts.length) continue;
      seen.add(symbol);
      const series: GammaSeries = {
        symbol,
        at: spotPoint[0],
        expiry: payload.expiry?.[symbol] ?? undefined,
        spot: spotPoint[1],
        lot: universe.find(item => item.symbol === symbol)?.lot ?? 1,
        quotes: contracts.map(contract => ({
          strike: contract.strike,
          side: contract.side,
          ltp: contract.ltp ?? contract.series.at(-1)?.[1] ?? 0,
          oi: contract.oi ?? contract.series.at(-1)?.[2] ?? 0,
          iv: contract.iv ?? contract.series.at(-1)?.[4] ?? null,
        })),
      };
      const profile = gammaProfile(series, { lot: series.lot, r: GAMMA_RISK_FREE });
      if (profile.strikes.length) output.push({ symbol, spot: spotPoint[1], profile });
    }
    return output;
  }, [payloads, universe]);
  const hasChain = Boolean(payloads && payloads.length > 0);
  const noChain = !loading && !failed && !hasChain;

  const bar = (
    <>
      {tabs}
      <CapsuleSegmented options={SUB_TABS} value={subTab} onChange={setSubTab} ariaLabel="Option Board views" groupId="option-views" size="page" />
      <CapsuleSegmented options={SCOPES} value={scope} onChange={setScope} ariaLabel="Option Board scope" groupId="option-scope" size="page" className="strike-flow__symbols" />
      {scope === 'fno-stocks' && (
        <>
          <label className="is-visually-hidden" htmlFor="strike-flow-stock">F&O stocks</label>
          <select id="strike-flow-stock" className="strike-flow__stocks" value={activeStock} onChange={event => { if (event.currentTarget.value) setStock(event.currentTarget.value); }}>
            {stocks.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
          </select>
        </>
      )}
      <span className="strike-flow__spacer" />
      <CapsuleSegmented options={MODES} value={side} onChange={setSide} ariaLabel="Option Board mode" groupId="option-mode" size="page" className="strike-flow__sides" />
      {subTab === 'option-board' && <GammaRegimeChips profiles={gammaProfiles} />}
      <button className="ui-flow-replay" type="button" aria-disabled="true" title="Replay is coming to Option Board soon">Replay</button>
      <ThemeToggle onChange={theme => applyTheme(theme)} size="md" className="ui-flow-theme" />
    </>
  );

  return (
    <div className="ui-flow oi-design ui-strike-flow" data-window={window} data-layout={phone ? 'phone' : fits ? 'desktop' : 'tablet'} data-fit={fits ? 'true' : undefined} ref={pageRef}>
      <h1 className="is-visually-hidden">Option Board · Momentum Flow</h1>
      <PageBar current="Option Board" crumbs={false} className="oi-design ui-flow-pagebar">{bar}</PageBar>
      {subTab === 'option-board' && !loading && !failed && <GammaOverlay profiles={gammaProfiles} />}

      {subTab === 'contracts-screener' ? (
        <section className="strike-flow__empty" role="status">
          <div><h2>Contracts Screener</h2><p>This view is coming soon. The Option Board above has every captured contract for now.</p><button className="ui-flow-replay" type="button" onClick={() => setSubTab('option-board')}>Back to Option Board</button></div>
        </section>
      ) : failed ? (
        <section className="strike-flow__empty" role="alert">
          <div><h2>Option chain could not be loaded</h2><p>The request failed. No premium or open-interest values are being shown.</p>{failedSymbols.length > 0 && <p>Failed: {failedSymbols.join(', ')}</p>}<button className="ui-flow-replay" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
        </section>
      ) : loading ? (
        <section className="strike-flow__empty" role="status"><div><h2>Reading the captured chain</h2><p>{symbols.join(' + ')} · {date}</p></div></section>
      ) : noChain ? (
        <section className="strike-flow__empty" role="status">
          <div><h2>No captured chain for {symbols.join(' + ')} on {date}</h2><p>No chain is available yet, or the archive could not be read. Retry to check the local archive again.</p>{unavailableSymbols.length > 0 && <p>Awaiting capture: {unavailableSymbols.join(', ')}</p>}<button className="ui-flow-replay" type="button" onClick={() => setRetry(value => value + 1)}>Retry archive</button></div>
        </section>
      ) : viewed ? (
        <FlowBoard key={hasChain ? 'loaded' : 'empty'} flow={viewed} settings={{ named: null, lines: 'all' }} layout={layout}
          status={<StatusLine board={viewed} />} />
      ) : null}
    </div>
  );
}
