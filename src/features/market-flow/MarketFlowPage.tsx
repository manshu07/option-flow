import { useEffect, useMemo, useRef, useState , type ReactNode} from 'react';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { applyTheme } from '@/lib/applyTheme';
import { CapsuleSegmented } from '@/components/common/CapsuleSegmented';
import { useFitScrollerHeight } from '@/hooks/useFitScrollerHeight';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { getLatestTradingSessionDate } from '@/lib/marketSession';
import type { Underlying } from '@/lib/underlyings';
import { FlowBoard, type FlowLayout } from './FlowBoard';
import { ReplayControls } from './ReplayControls';
import { FlowStatus } from './FlowStatus';
import { DEFAULT_FLOW_SETTINGS, type FlowSettings } from './marketFlowModel';
import { inExchange, inUniverse, loadExchange, loadUniverse, saveExchange, saveUniverse, type FlowExchange, type FlowUniverse } from './nifty50';
import { useMarketFlow } from './useMarketFlow';
import { useReplayFlow } from './useReplayFlow';

/*
 * The workspace stylesheet chain, in the order the other pages import it:
 * the shared tokens (`oi-design` publishes --dash-* and the numeric ramp),
 * this page's own sheet, then the page finish last so it never needs
 * !important.
 */
import '@/styles/oi-design-tokens.css';
import './market-flow.css';
import '../underlying/pages-finish.css';

/**
 * Order Flow. Every F&O underlying, read from its future: the day's flow as
 * one chart on the left (bulls rising above the zero rule, bears falling
 * below it), the Bullish half over the Bearish half on the right, each a grid
 * of small tiles ranked by the move and one or two large cards. Hovering a
 * tile lights its line and opens its detail; hovering a line lights its tile.
 *
 * The page keeps nothing of its own. The market file and the futures are the
 * Options Scanner's reads (useMarketFlow), the build-up words are the
 * scanner's, the levels are the chain's open interest. The one choice, the
 * NIFTY 50 or every F&O underlying, is remembered in this browser.
 */

/** The board always reads the whole day, every line drawn, at the day's own floor. */
const SETTINGS: FlowSettings = DEFAULT_FLOW_SETTINGS;
const CHART = { named: SETTINGS.named, lines: SETTINGS.lines };

interface MarketFlowPageProps {
  universe: Underlying[];
  /** The app's Order Flow / Strike Flow capsule, rendered first in this page's bar (additive; optional keeps existing callers unchanged). */
  tabs?: ReactNode;
}

const UNIVERSES: Array<{ value: FlowUniverse; label: string; title: string }> = [
  { value: 'nifty50', label: 'Nifty 50', title: 'The NIFTY 50 constituents' },
  { value: 'fno', label: 'All F&O', title: 'Every F&O underlying: stocks and indices' },
];

/** Exchanges are viewed separately, never mixed (owner: "dono alag"). */
const EXCHANGES: Array<{ value: FlowExchange; label: string; title: string }> = [
  { value: 'NSE', label: 'NSE', title: 'National Stock Exchange underlyings' },
  { value: 'BSE', label: 'BSE', title: 'BSE underlyings (Sensex family and BSE-only F&O stocks)' },
];

export function MarketFlowPage({ universe, tabs }: MarketFlowPageProps) {
  const [exchange, setExchange] = useState<FlowExchange>(loadExchange);
  const [scope, setScope] = useState<FlowUniverse>(loadUniverse);
  const [replayRequested, setReplayRequested] = useState(false);
  const [replayDate, setReplayDate] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const wider = useMediaQuery('(min-width: 1280px)');
  const wide = useMediaQuery('(min-width: 1100px)');
  const phone = useMediaQuery('(max-width: 768px)');
  const layout: FlowLayout = wider ? 'diagram' : wide ? 'desktop' : phone ? 'phone' : 'tablet';
  // A desktop board is the window's height; the other layouts scroll the page.
  const fits = layout === 'desktop' || layout === 'diagram';
  useFitScrollerHeight(pageRef, fits);
  useEffect(() => { saveUniverse(scope); }, [scope]);
  useEffect(() => { saveExchange(exchange); }, [exchange]);

  // The Nifty 50 / All F&O switch only makes sense inside NSE; BSE carries its
  // own (small) list and would otherwise look empty.
  const shown = useMemo(() => universe.filter(item => inExchange(exchange, item) && (exchange === 'BSE' || inUniverse(item.symbol, scope))), [universe, scope, exchange]);
  const live = useMarketFlow(shown, SETTINGS);
  const replay = useReplayFlow(shown, SETTINGS, { requested: replayRequested, date: replayDate ?? live.market?.date ?? getLatestTradingSessionDate(new Date()) });
  const isReplay = replayRequested;
  const flow = isReplay ? replay.flow : live.flow;
  const market = isReplay ? replay.market : live.market;
  const loading = isReplay ? replay.loading : live.loading;
  const error = isReplay ? replay.error : live.error;
  const provider = isReplay ? replay.provider : live.provider;
  const futuresRead = isReplay ? replay.futuresRead : live.futuresRead;
  const futuresTotal = isReplay ? replay.futuresTotal : live.futuresTotal;
  const rescan = isReplay ? replay.retry : live.rescan;
  const closeReplay = () => {
    replay.goLive();
    setReplayRequested(false);
    setReplayDate(null);
  };
  const toggleReplay = () => {
    if (replayRequested) closeReplay();
    else {
      setReplayDate(live.market?.date ?? getLatestTradingSessionDate(new Date()));
      setReplayRequested(true);
    }
  };

  const pageActions = (
    <>
      {tabs}
      <CapsuleSegmented options={EXCHANGES} value={exchange} onChange={setExchange} ariaLabel="Exchange" groupId="flow-exchange" size="page" className="ui-flow-exchange" />
      {exchange === 'NSE' && <CapsuleSegmented options={UNIVERSES} value={scope} onChange={setScope} ariaLabel="Underlyings" groupId="flow-universe" size="page" className="ui-flow-universe" />}
      <button className={`ui-flow-replay${replayRequested ? ' is-active' : ''}`} type="button" data-testid="flow-replay-open" aria-label={replayRequested ? 'Close market replay' : 'Open market replay'} onClick={toggleReplay}>
        Replay
      </button>
      <ThemeToggle onChange={theme => applyTheme(theme)} size="md" className="ui-flow-theme" />
    </>
  );

  return (
    <div className="ui-flow oi-design" data-window="day" data-exchange={exchange} data-universe={scope} data-layout={layout} data-fit={fits ? 'true' : undefined} ref={pageRef}>
      <h1 className="is-visually-hidden">Order Flow</h1>
      <PageBar current="Order Flow" crumbs={false} className="oi-design ui-flow-pagebar">{pageActions}</PageBar>
      {replayRequested && <ReplayControls manifest={replay.manifest} mode={replay.mode} loading={replay.loading} error={replay.error} notice={replay.notice} retryableFutures={replay.retryableFutures} retryingFutures={replay.retryingFutures} cursorLabel={replay.cursorLabel} onPlay={replay.togglePlay} onSeek={replay.seek} onRetry={replay.retry} onLive={closeReplay} days={replay.days} selectedDate={replay.selectedDate} selectedSource={replay.selectedSource} onSelectDay={replay.selectDay} window={replay.window} customStart={replay.customStart} customEnd={replay.customEnd} onWindow={replay.setWindow} speed={replay.speed} onSpeed={replay.setSpeed} phone={phone} />}
      <FlowBoard key={scope} flow={flow} settings={CHART} layout={layout}
        status={<FlowStatus flow={flow} at={market?.at ?? null} loading={loading} error={error} provider={provider} futuresRead={futuresRead} futuresTotal={futuresTotal} onRescan={rescan} />} />
    </div>
  );
}
