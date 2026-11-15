import { useEffect } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { Ring } from '../market-flow/FlowDiagram';
import { BuildMark, ChangeText, buildUpText, heatStyle, pctText, signedText } from '../market-flow/FlowParts';
import { candlesFromCloses } from '../market-flow/diagramModel';
import { MINUTE } from '../market-flow/flowChartModel';
import { compactUnits, levelText, type FlowCandle } from '../market-flow/marketFlowModel';
import type { StrikeFlowPayload } from './feed';
import { spotChangeForWindow, strikeCardChecks, strikePremiumZone, type StrikeCardCheck, type StrikeWalls } from './strikeCardModel';
import type { StrikeFlowWindow, StrikeReading } from './strikeFlowModel';

export type StrikeChartTimeframe = 'auto' | '1m' | '5m' | '15m' | '30m';

const CHART_TIMEFRAMES: CapsuleOption<StrikeChartTimeframe>[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
];

interface StrikeRangeProps {
  symbol: string;
  spot: number | null;
  walls: StrikeWalls;
}

interface StrikePremiumChartProps {
  reading: StrikeReading;
  window: StrikeFlowWindow;
  timeframe: StrikeChartTimeframe;
  onTimeframeChange: (timeframe: StrikeChartTimeframe) => void;
  size?: 'card' | 'popup';
}

export interface StrikeFlowCardProps {
  flow: StrikeFlowPayload;
  reading: StrikeReading;
  window: StrikeFlowWindow;
  walls: StrikeWalls;
  spotDayChangePct: number | null;
  timeframe: StrikeChartTimeframe;
  onTimeframeChange: (timeframe: StrikeChartTimeframe) => void;
  onOpen: () => void;
}

export interface StrikeFlowPopupProps extends Omit<StrikeFlowCardProps, 'onOpen' | 'onTimeframeChange'> {
  onClose: () => void;
  onTimeframeChange: (timeframe: StrikeChartTimeframe) => void;
}

function strikeName(reading: StrikeReading): string {
  return `${reading.symbol} ${levelText(reading.strike)}${reading.side === 'CE' ? 'C' : 'PE'}`;
}

function rupees(value: number | null): string {
  return value === null ? '—' : `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function strikeChartSeries(reading: StrikeReading, window: StrikeFlowWindow): StrikeReading['series'] {
  if (window === 'day') return reading.series;
  if (reading.premiumBaselineAt === null) return [];
  return reading.series.filter(point => point[0] + MINUTE >= reading.premiumBaselineAt!);
}

function chartSpan(timeframe: StrikeChartTimeframe, window: StrikeFlowWindow): number {
  if (timeframe !== 'auto') return Number.parseInt(timeframe, 10);
  return window === 'day' ? 15 : 1;
}

function StrikePremiumChart({ reading, window, timeframe, onTimeframeChange, size = 'card' }: StrikePremiumChartProps) {
  const source = strikeChartSeries(reading, window);
  const minutes = chartSpan(timeframe, window);
  // The shared resampler only reads `at` and `close`; NaN keeps absent OI absent instead of inventing zero OI.
  const closeSeries: FlowCandle[] = source.map(([at, close, oi]) => ({ at, close, oi: oi ?? Number.NaN }));
  const candles = candlesFromCloses(closeSeries, minutes);
  const width = size === 'popup' ? 720 : 360;
  const height = size === 'popup' ? 220 : 112;
  const left = 8;
  const right = width - 8;
  const top = 8;
  const bottom = height - 14;
  const values = candles.flatMap(candle => [candle.low, candle.high]);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  const pad = high > low ? (high - low) * 0.12 : Math.max(Math.abs(high) * 0.015, 0.5);
  const min = low - pad;
  const max = high + pad;
  const yOf = (value: number) => bottom - ((value - min) / Math.max(0.01, max - min)) * (bottom - top);
  const step = candles.length ? (right - left) / candles.length : 0;
  const bodyWidth = Math.max(1.5, Math.min(size === 'popup' ? 10 : 6, step * 0.52));
  const tooFew = source.length < 3;

  return (
    <div className={`strike-card__chart strike-card__chart--${size}`}>
      <div className="strike-card__chart-head">
        <span>Premium · {timeframe === 'auto' ? `Auto ${minutes}m` : timeframe}</span>
        <CapsuleSegmented
          options={CHART_TIMEFRAMES}
          value={timeframe}
          onChange={onTimeframeChange}
          ariaLabel={`${strikeName(reading)} chart timeframe`}
          groupId={`strike-tf-${reading.symbol}-${reading.key}-${size}`}
          size="page"
          className="strike-card__tf"
        />
      </div>
      {tooFew ? (
        <div className="strike-card__chart-empty">Too few minutes yet for a line</div>
      ) : (
        <svg className="strike-card__candle-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${strikeName(reading)} premium candles at ${timeframe} timeframe`}>
          {[0, 0.5, 1].map(ratio => {
            const y = top + ratio * (bottom - top);
            const value = max - ratio * (max - min);
            return <g key={ratio}><line className="strike-card__grid" x1={left} x2={right} y1={y} y2={y} /><text className="strike-card__axis" x={right} y={y - 2} textAnchor="end">₹{value.toFixed(1)}</text></g>;
          })}
          {candles.map((candle, index) => {
            const x = left + (index + 0.5) * step;
            const yOpen = yOf(candle.open);
            const yClose = yOf(candle.close);
            const yHigh = yOf(candle.high);
            const yLow = yOf(candle.low);
            const isUp = candle.close >= candle.open;
            const rectY = Math.min(yOpen, yClose);
            const rectHeight = Math.max(1.4, Math.abs(yOpen - yClose));
            return (
              <g key={candle.at} className={isUp ? 'is-up' : 'is-down'}>
                <line className="strike-card__wick" x1={x} x2={x} y1={yHigh} y2={yLow} />
                <rect className="strike-card__body" x={x - bodyWidth / 2} y={rectY} width={bodyWidth} height={rectHeight} rx="0.8" />
              </g>
            );
          })}
          {candles.length > 0 && <text className="strike-card__last-price" x={right} y={top + 9} textAnchor="end">{rupees(candles.at(-1)?.close ?? null)}</text>}
        </svg>
      )}
    </div>
  );
}

function StrikeRange({ symbol, spot, walls }: StrikeRangeProps) {
  const { support, resistance } = walls;
  const valid = spot !== null && support !== null && resistance !== null && support.strike < spot && resistance.strike > spot;
  const spotPosition = valid ? ((spot - support.strike) / (resistance.strike - support.strike)) * 100 : null;
  const label = valid
    ? `${symbol} spot ${levelText(spot)} between support ${levelText(support.strike)} and resistance ${levelText(resistance.strike)}`
    : `${symbol} spot range unavailable; support ${support ? levelText(support.strike) : 'unavailable'}, resistance ${resistance ? levelText(resistance.strike) : 'unavailable'}`;

  return (
    <div className="strike-card__range">
      <div className="strike-card__range-labels">
        <span><i>SUPPORT</i><b>{support ? levelText(support.strike) : '—'}</b></span>
        <span><i>SPOT</i><b>{spot === null ? '—' : levelText(spot)}</b></span>
        <span><i>RESISTANCE</i><b>{resistance ? levelText(resistance.strike) : '—'}</b></span>
      </div>
      <span className={`mf-range${valid ? '' : ' is-empty'}`} role="img" aria-label={label}>
        {valid && <>
          <i className="strike-card__wall-marker is-support" />
          <i className="mf-range__spot" style={{ left: `${spotPosition}%` }} />
          <i className="strike-card__wall-marker is-resistance" />
        </>}
      </span>
    </div>
  );
}

function checkLabel(check: StrikeCardCheck): string {
  return check.pass === null ? 'Not counted' : check.pass ? 'Held' : 'Not held';
}

function StrikeCardFacts({ reading, zone, spotDayChangePct, walls, spot }: {
  reading: StrikeReading;
  zone: ReturnType<typeof strikePremiumZone>;
  spotDayChangePct: number | null;
  walls: StrikeWalls;
  spot: number | null;
}) {
  return (
    <>
      <div className="strike-card__levels">
        <span><i>SUPPORT</i><b>{walls.support ? levelText(walls.support.strike) : '—'}</b></span>
        <span><i>ZONE</i><b>{zone ? `${rupees(zone.low)}–${rupees(zone.high)}` : '—'}</b></span>
        <span><i>RESISTANCE</i><b>{walls.resistance ? levelText(walls.resistance.strike) : '—'}</b></span>
      </div>
      <StrikeRange symbol={reading.symbol} spot={spot} walls={walls} />
      <div className="strike-card__spot-day">
        <span>Underlying day move</span>
        <ChangeText value={spotDayChangePct} />
      </div>
    </>
  );
}

export function StrikeFlowCard({ flow, reading, window, walls, spotDayChangePct, timeframe, onTimeframeChange, onOpen }: StrikeFlowCardProps) {
  const spot = flow.spot.at(-1)?.[1] ?? null;
  const spotWindowMove = spotChangeForWindow(flow, window);
  const checks = strikeCardChecks(reading, spotWindowMove, window);
  const held = checks.filter(check => check.pass === true).length;
  const counted = checks.filter(check => check.pass !== null).length;
  const zone = strikePremiumZone(reading, window);
  const direction = reading.direction === 'up' ? 'up' : 'down';
  const noOi = reading.oi === null || reading.oi === 0;
  const buildUp = noOi ? 'No OI' : buildUpText({ buildUp: reading.buildUp, futures: 'read' });

  return (
    <article className={`strike-card is-${direction}`} style={heatStyle(reading.premiumChangePct)}>
      <header className="strike-card__header">
        <div className="strike-card__identity">
          <h3 title={`${strikeName(reading)} · ${reading.expiry ?? 'expiry unavailable'}`}>{strikeName(reading)}</h3>
          <span className={`mf-badge is-${direction === 'up' ? 'bullish' : 'bearish'}`}>{direction === 'up' ? 'BULLISH' : 'BEARISH'}</span>
          <BuildMark stock={{ buildUp: reading.buildUp }} />
          <span className={`strike-card__ring-tone is-${direction}`}><Ring held={held} counted={counted} /></span>
        </div>
        <button className="strike-card__details" type="button" onClick={onOpen} aria-label={`Open details for ${strikeName(reading)}`}>Details</button>
      </header>
      <div className="strike-card__premium">
        <div>
          <ChangeText value={reading.premiumChangePct} className="strike-card__change" />
          <div className="strike-card__price">{rupees(reading.ltp)} <span>{reading.premiumChange === null ? '—' : `₹${signedText(reading.premiumChange)}`}</span></div>
        </div>
        <div className="strike-card__oi">
          <span>{noOi ? 'No OI' : `${compactUnits(reading.oi!)} OI`}</span>
          <small>Δ {reading.oiChange === null ? '—' : signedText(reading.oiChange)}</small>
        </div>
      </div>
      <div className="strike-card__build-up"><span>BUILD-UP</span><b>{buildUp}</b></div>
      <StrikePremiumChart reading={reading} window={window} timeframe={timeframe} onTimeframeChange={onTimeframeChange} />
      <StrikeCardFacts reading={reading} zone={zone} spotDayChangePct={spotDayChangePct} walls={walls} spot={spot} />
      <ul className="strike-card__checks" aria-label="Conviction checks">
        {checks.map(check => <li key={check.id} className={check.pass === null ? 'is-unknown' : check.pass ? 'is-held' : 'is-open'}><span>{checkLabel(check)}</span><b>{check.label}</b><small>{check.note}</small></li>)}
      </ul>
    </article>
  );
}

export function StrikeFlowPopup({ flow, reading, window, walls, spotDayChangePct, timeframe, onTimeframeChange, onClose }: StrikeFlowPopupProps) {
  const spot = flow.spot.at(-1)?.[1] ?? null;
  const spotWindowMove = spotChangeForWindow(flow, window);
  const checks = strikeCardChecks(reading, spotWindowMove, window);
  const held = checks.filter(check => check.pass === true).length;
  const counted = checks.filter(check => check.pass !== null).length;
  const zone = strikePremiumZone(reading, window);
  const noOi = reading.oi === null || reading.oi === 0;
  const buildUp = noOi ? 'No OI' : buildUpText({ buildUp: reading.buildUp, futures: 'read' });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    globalThis.window.addEventListener('keydown', onKeyDown);
    return () => globalThis.window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="strike-popup-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="strike-popup" role="dialog" aria-modal="true" aria-labelledby="strike-popup-title">
        <header className="strike-popup__header">
          <div><h2 id="strike-popup-title">{strikeName(reading)}</h2><span>{reading.expiry ?? 'Expiry unavailable'} · {flow.date}</span></div>
          <span className={`strike-popup__ring is-${reading.direction === 'up' ? 'up' : 'down'}`}><Ring held={held} counted={counted} /></span>
          <button className="strike-popup__close" type="button" onClick={onClose} autoFocus aria-label="Close strike details">×</button>
        </header>
        <div className="strike-popup__content">
          <div className="strike-popup__reading">
            <BuildMark stock={{ buildUp: reading.buildUp }} />
            <strong>{buildUp}</strong>
            <p>{buildUp === 'No OI' ? 'Open interest is unavailable or zero, so no build-up label is assigned.' : buildUp}</p>
          </div>
          <div className="strike-popup__facts">
            <span><i>Premium</i><b>{rupees(reading.ltp)}</b></span>
            <span><i>Premium change</i><b>{pctText(reading.premiumChangePct)} · {reading.premiumChange === null ? '—' : `₹${signedText(reading.premiumChange)}`}</b></span>
            <span><i>Open interest</i><b>{reading.oi === null ? '—' : compactUnits(reading.oi)}</b></span>
            <span><i>OI change</i><b>{reading.oiChange === null ? '—' : signedText(reading.oiChange)}</b></span>
            <span><i>Volume</i><b>{reading.volume === null ? '—' : compactUnits(reading.volume)}</b></span>
            <span><i>Volume pace</i><b>{reading.volumePace === null ? '—' : `${reading.volumePace.toFixed(1)}/min`}</b></span>
            <span><i>Underlying day move</i><b>{pctText(spotDayChangePct)}</b></span>
            <span><i>Spot distance</i><b>{reading.spotDistancePct === null ? '—' : `${reading.spotDistancePct.toFixed(2)}%`}</b></span>
          </div>
          <StrikePremiumChart reading={reading} window={window} timeframe={timeframe} onTimeframeChange={onTimeframeChange} size="popup" />
          <StrikeCardFacts reading={reading} zone={zone} spotDayChangePct={spotDayChangePct} walls={walls} spot={spot} />
          <ul className="strike-card__checks strike-popup__checks" aria-label="Conviction checks">
            {checks.map(check => <li key={check.id} className={check.pass === null ? 'is-unknown' : check.pass ? 'is-held' : 'is-open'}><span>{checkLabel(check)}</span><b>{check.label}</b><small>{check.note}</small></li>)}
          </ul>
        </div>
      </section>
    </div>
  );
}
