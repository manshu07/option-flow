import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { useFitScrollerHeight } from '@/hooks/useFitScrollerHeight';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { applyTheme } from '@/lib/applyTheme';
import { getLatestTradingSessionDate } from '@/lib/marketSession';
import { HEADER_MARKET_SYMBOLS, type Underlying } from '@/lib/underlyings';
import { clockOf } from '../market-flow/marketFlowModel';
import { fetchStrikeFlow, type StrikeFlowPayload } from './feed';
import { StrikeFlowPopup, type StrikeChartTimeframe } from './StrikeFlowCards';
import { StrikeFlowDiagram } from './StrikeFlowDiagram';
import { spotChangeForWindow, strikeWalls } from './strikeCardModel';
import { filterStrikeReadings, strikeReadings, type StrikeFlowWindow, type StrikeReading, type StrikeSideFilter } from './strikeFlowModel';
import '@/styles/oi-design-tokens.css';
import '../market-flow/market-flow.css';
import '../underlying/pages-finish.css';
import './strike-flow.css';

interface StrikeFlowPageProps {
  universe: Underlying[];
  /** The app's Order Flow / Strike Flow capsule, rendered inside this page's bar row. */
  tabs?: ReactNode;
}

const SYMBOLS: CapsuleOption<string>[] = HEADER_MARKET_SYMBOLS.map(symbol => ({ value: symbol, label: symbol }));
const WINDOWS: CapsuleOption<StrikeFlowWindow>[] = [
  { value: 'day', label: 'Day' },
  { value: '1h', label: '1h' },
  { value: '15m', label: '15m' },
  { value: '5m', label: '5m' },
];
const SIDES: CapsuleOption<StrikeSideFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'CE', label: 'CE' },
  { value: 'PE', label: 'PE' },
];

const BRAND = (
  <a className="mf-brand" href="https://mrchartist.com/open-source/order-flow" target="_blank" rel="noreferrer" aria-label="Strike Flow by Mr. Chartist">
    <span className="mf-brand__dot" aria-hidden="true" />
    <span className="mf-brand__name">Strike <em>Flow</em></span>
    <span className="mf-brand__by">by Mr. Chartist</span>
  </a>
);

function latestAt(flow: StrikeFlowPayload): number | null {
  const times = [flow.spot.at(-1)?.[0] ?? null, ...Object.values(flow.strikes).map(contract => contract.series.at(-1)?.[0] ?? null)]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return times.length ? Math.max(...times) : null;
}

function StatusLine({ flow, readings, loading, failed }: { flow: StrikeFlowPayload | null; readings: StrikeReading[]; loading: boolean; failed: boolean }) {
  if (loading) return <div className="strike-flow__status mf-status" role="status">Loading captured strike chain…</div>;
  if (failed) return <div className="strike-flow__status mf-status" role="status">Strike chain request failed · values withheld</div>;
  if (!flow) return <div className="strike-flow__status mf-status" role="status">No captured chain is currently available.</div>;

  const up = readings.filter(reading => reading.direction === 'up').length;
  const flat = readings.filter(reading => reading.direction === 'flat').length;
  const down = readings.filter(reading => reading.direction === 'down').length;
  const measured = up + flat + down;
  const unknown = readings.length - measured;
  const spotAt = flow.spot.at(-1)?.[0] ?? null;
  const asOf = latestAt(flow);

  return (
    <div className="strike-flow__status mf-status" role="status" aria-live="polite">
      <span><b className="is-up">{up} up</b> · <b className="is-flat">{flat} flat</b> · <b className="is-down">{down} down</b> of {measured} measured</span>
      {unknown > 0 && <span>{unknown} awaiting baseline</span>}
      <span className="strike-flow__status-time">{asOf === null ? flow.date : `As of ${flow.date} ${clockOf(asOf)}`} · spot to {spotAt === null ? '—' : clockOf(spotAt)}</span>
    </div>
  );
}

export function StrikeFlowPage({ universe, tabs }: StrikeFlowPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const fits = useMediaQuery('(min-width: 1100px)');
  const phone = useMediaQuery('(max-width: 768px)');
  const [symbol, setSymbol] = useState('NIFTY');
  const [window, setWindow] = useState<StrikeFlowWindow>('day');
  const [side, setSide] = useState<StrikeSideFilter>('all');
  const [date] = useState(() => getLatestTradingSessionDate());
  const [flow, setFlow] = useState<StrikeFlowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedCard, setSelectedCard] = useState<{ symbol: string; key: string } | null>(null);
  const [cardTimeframes, setCardTimeframes] = useState<Record<string, StrikeChartTimeframe>>({});

  useFitScrollerHeight(pageRef, fits);

  useEffect(() => {
    const controller = new AbortController();
    setSelectedCard(null);
    setFlow(null);
    setLoading(true);
    setFailed(false);
    void fetchStrikeFlow(symbol, { date, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setFlow(result);
      setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setFailed(true);
      setLoading(false);
    });
    return () => controller.abort();
  }, [symbol, date, retry]);

  const stocks = universe.filter(item => item.kind === 'stock').slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  const selectedStock = stocks.some(item => item.symbol === symbol) ? symbol : '';
  const allReadings = flow ? strikeReadings(flow, window) : [];
  const readings = filterStrikeReadings(allReadings, side);
  const upCards = readings.filter(reading => reading.direction === 'up').slice(0, 3);
  const downCards = readings.filter(reading => reading.direction === 'down').slice(0, 3);
  const spotDayChangePct = flow ? spotChangeForWindow(flow, 'day') : null;
  const walls = flow ? strikeWalls(flow) : { support: null, resistance: null };
  const popupReading = flow && selectedCard?.symbol === flow.symbol
    ? allReadings.find(reading => reading.key === selectedCard.key) ?? null
    : null;
  const hasChain = Boolean(flow && Object.keys(flow.strikes).length > 0);
  const noChain = !loading && !failed && !hasChain;
  const noSideData = !loading && !failed && hasChain && readings.length === 0;

  // One slim bar row, Order Flow's chrome: brand (PageBar) · tabs · scope chips ·
  // F&O stocks · spacer · mode pill · side filter · window · theme.
  const pageActions = (
    <div className="strike-flow__bar">
      {tabs}
      <CapsuleSegmented
        options={SYMBOLS}
        value={HEADER_MARKET_SYMBOLS.includes(symbol) ? symbol : ''}
        onChange={setSymbol}
        ariaLabel="Strike Flow symbols"
        groupId="strike-symbols"
        size="page"
        className="strike-flow__symbols"
      />
      <label className="is-visually-hidden" htmlFor="strike-flow-stock">F&O stocks</label>
      <select id="strike-flow-stock" className="strike-flow__stocks" value={selectedStock} onChange={event => { if (event.currentTarget.value) setSymbol(event.currentTarget.value); }}>
        <option value="">F&O stocks</option>
        {stocks.map(item => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
      </select>
      <span className="strike-flow__spacer" />
      <span className="strike-flow__mode">Momentum Flow</span>
      <CapsuleSegmented options={SIDES} value={side} onChange={setSide} ariaLabel="Option side" groupId="strike-side" size="page" className="strike-flow__sides" />
      <CapsuleSegmented options={WINDOWS} value={window} onChange={setWindow} ariaLabel="Premium change window" groupId="strike-window" size="page" className="strike-flow__window" />
      <ThemeToggle onChange={theme => applyTheme(theme)} size="md" className="ui-flow-theme" />
    </div>
  );

  return (
    <div className="ui-flow oi-design ui-strike-flow" data-window={window} data-layout={phone ? 'phone' : fits ? 'desktop' : 'tablet'} data-fit={fits ? 'true' : undefined} ref={pageRef}>
      <h1 className="is-visually-hidden">Strike Flow · Momentum Flow</h1>
      <PageBar current="Strike Flow" crumbs={false} className="oi-design ui-flow-pagebar ui-strike-flow-pagebar" brand={BRAND}>{pageActions}</PageBar>

      <StatusLine flow={flow} readings={readings} loading={loading} failed={failed} />

      {failed ? (
        <section className="strike-flow__empty" role="alert">
          <div><h2>Strike chain could not be loaded</h2><p>The request failed. No premium or open-interest values are being shown.</p><button className="ui-flow-replay" type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
        </section>
      ) : loading ? (
        <section className="strike-flow__empty" role="status"><div><h2>Reading the captured chain</h2><p>{symbol} · {date}</p></div></section>
      ) : noChain ? (
        <section className="strike-flow__empty" role="status">
          <div><h2>No captured chain for {symbol} on {date}</h2><p>No chain is available yet, or the archive could not be read. Retry to check the local archive again.</p><button className="ui-flow-replay" type="button" onClick={() => setRetry(value => value + 1)}>Retry archive</button></div>
        </section>
      ) : noSideData ? (
        <section className="strike-flow__empty" role="status">
          <div><h2>No {side} contracts in this chain</h2><p>Switch the side filter to All or the other option side to view the captured contracts.</p></div>
        </section>
      ) : flow ? (
        <>
          <StrikeFlowDiagram
            flow={flow}
            readings={readings}
            window={window}
            upCards={upCards}
            downCards={downCards}
            cardTimeframes={cardTimeframes}
            onCardTimeframeChange={(id, timeframe) => setCardTimeframes(current => ({ ...current, [id]: timeframe }))}
            onOpenCard={reading => setSelectedCard({ symbol: flow.symbol, key: reading.key })}
          />
          {popupReading && <StrikeFlowPopup flow={flow} reading={popupReading} window={window} walls={walls} spotDayChangePct={spotDayChangePct} timeframe={cardTimeframes[`${flow.symbol}:${popupReading.key}`] ?? 'auto'} onTimeframeChange={timeframe => setCardTimeframes(current => ({ ...current, [`${flow.symbol}:${popupReading.key}`]: timeframe }))} onClose={() => setSelectedCard(null)} />}
        </>
      ) : null}
    </div>
  );
}
