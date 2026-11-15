import type { CSSProperties } from 'react';
import { BUILD_UP_NOISE_FLOOR, type BuildUpWindow } from '@/lib/buildUp';
import { marketSessionBounds } from '@/lib/marketSession';
import { axisReach } from '../market-flow/flowLayout';
import { buildUpText, heatStyle, pctText, signedText } from '../market-flow/FlowParts';
import { MINUTE, pathOf, timeTicks, type FlowLine } from '../market-flow/flowChartModel';
import { compressedScale, compressedTicks, drawnValues, gateRows, sCurve, sCurveOn } from '../market-flow/diagramModel';
import { clockOf } from '../market-flow/marketFlowModel';
import { SCAN_WINDOW_MINUTES, SCAN_WINDOW_TOLERANCE_MS, type IntradayWindow } from '../options-scanner/contractScanModel';
import type { StrikeFlowPayload, StrikeSeriesPoint } from './feed';
import { StrikeFlowCard, type StrikeChartTimeframe } from './StrikeFlowCards';
import type { StrikeFlowWindow, StrikeReading } from './strikeFlowModel';
import { spotChangeForWindow, strikeWalls, type StrikeWalls } from './strikeCardModel';

interface StrikeFlowDiagramProps {
  flow: StrikeFlowPayload;
  readings: StrikeReading[];
  window: StrikeFlowWindow;
  /** The reference layout keeps the leaders inline with the flow, right of the tiles. */
  upCards: StrikeReading[];
  downCards: StrikeReading[];
  cardTimeframes: Record<string, StrikeChartTimeframe>;
  onCardTimeframeChange: (id: string, timeframe: StrikeChartTimeframe) => void;
  onOpenCard: (reading: StrikeReading) => void;
}

interface CurveData {
  line: FlowLine | null;
  spark: StrikeSeriesPoint[];
  reason: 'baseline' | 'few' | null;
}

interface Box { x: number; y: number; width: number; height: number }
interface DrawableCurve { reading: StrikeReading; curve: CurveData & { line: FlowLine } }

const WIDTH = 1_180;
const PLOT_LEFT = 74;
const PLOT_RIGHT = 626;
const GATE_LEFT = 646;
const GATE_RIGHT = 682;
const TILES_X = 710;
const TILE_GAP = 7;
const TILE_HEIGHT = 32;
const TILE_PITCH = 38;
const TILE_COLUMNS = 3;
const TOP = 64;
const MIN_HALF = 4 * TILE_PITCH;
const TICK_WINDOW: Record<StrikeFlowWindow, 'day' | '1h' | '15m'> = { day: 'day', '1h': '1h', '15m': '15m', '5m': '15m' };
const BUILD_UP_TIMEFRAME: Record<StrikeFlowWindow, BuildUpWindow> = { day: '1d', '1h': '1h', '15m': '15m', '5m': '5m' };

function roundedReach(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 0.1)));
  return Math.ceil(value / magnitude - 1e-9) * magnitude;
}

function chartBounds(date: string, readings: StrikeReading[], flow: StrikeFlowPayload, window: StrikeFlowWindow) {
  const session = marketSessionBounds(Date.parse(`${date}T12:00:00+05:30`));
  const samples = [flow.spot.at(-1)?.[0] ?? null, ...readings.map(reading => reading.lastAt)]
    .filter((at): at is number => at !== null && Number.isFinite(at));
  const latest = samples.length ? Math.max(...samples) + MINUTE : session.close;
  const end = Math.min(session.close, Math.max(session.open + MINUTE, latest));
  const minutes = window === 'day' ? 0 : window === '1h' ? 60 : window === '15m' ? 15 : 5;
  const start = window === 'day' ? session.open : Math.max(session.open, end - minutes * MINUTE);
  return { open: session.open, close: session.close, start, end: Math.max(start + MINUTE, end) };
}

function curveFor(reading: StrikeReading, window: StrikeFlowWindow, start: number, end: number): CurveData {
  const windowMinutes = window === 'day' ? null : window === '1h' ? 60 : window === '15m' ? 15 : 5;
  const windowStart = windowMinutes === null || reading.lastAt === null
    ? start
    : Math.max(start, reading.lastAt + MINUTE - windowMinutes * MINUTE);
  const spark = reading.series.filter(point => {
    const at = point[0] + MINUTE;
    return at >= windowStart && at <= end;
  });
  const baseline = reading.premiumBaselineLtp;
  if (baseline === null || baseline <= 0 || (window !== 'day' && reading.premiumBaselineAt === null)) {
    return { line: null, spark, reason: 'baseline' };
  }

  const baselineAt = window === 'day' ? start : reading.premiumBaselineAt;
  if (baselineAt === null) return { line: null, spark, reason: 'baseline' };
  const points = reading.series.filter(point => {
    const at = point[0] + MINUTE;
    return at >= baselineAt && at >= start && at <= end;
  });
  if (points.length < 3) return { line: null, spark: points, reason: 'few' };

  const values = points.map(point => (point[1] / baseline - 1) * 100);
  return {
    line: { symbol: reading.key, t: points.map(point => point[0] + MINUTE), v: drawnValues(values) },
    spark: points,
    reason: null,
  };
}

function spotLine(flow: StrikeFlowPayload, start: number, end: number, window: StrikeFlowWindow): { line: FlowLine | null; baselineAt: number | null; changePct: number | null } {
  const first = flow.spot[0];
  if (!first || first[1] <= 0) return { line: null, baselineAt: null, changePct: null };
  // Day reads against the underlying's previous close; intraday against the
  // captured minute nearest the window's start, inside its tolerance.
  let baseline: { at: number; price: number } | null = null;
  if (window === 'day') {
    baseline = flow.spotPrevClose != null && flow.spotPrevClose > 0
      ? { at: first[0] - MINUTE, price: flow.spotPrevClose }
      : { at: first[0], price: first[1] };
  } else {
    const intradayWindow: IntradayWindow = window;
    const target = end - SCAN_WINDOW_MINUTES[intradayWindow] * MINUTE;
    let gap = Infinity;
    for (const point of flow.spot) {
      const at = point[0] + MINUTE;
      if (at >= end) continue;
      const distance = Math.abs(at - target);
      if (distance < gap) { baseline = { at: point[0], price: point[1] }; gap = distance; }
    }
    if (!baseline || gap > SCAN_WINDOW_TOLERANCE_MS[intradayWindow] || baseline.price <= 0) return { line: null, baselineAt: null, changePct: null };
  }
  if (!baseline || baseline.price <= 0) return { line: null, baselineAt: null, changePct: null };
  const baselineAt = baseline.at + MINUTE;
  const points = flow.spot.filter(point => point[0] + MINUTE >= baselineAt && point[0] + MINUTE <= end);
  const last = points.at(-1);
  const changePct = last ? (last[1] / baseline.price - 1) * 100 : null;
  if (points.length < 2) return { line: null, baselineAt, changePct };
  const values = points.map(point => (point[1] / baseline.price - 1) * 100);
  return {
    line: { symbol: flow.symbol, t: points.map(point => point[0] + MINUTE), v: drawnValues(values) },
    baselineAt,
    changePct,
  };
}

function sparkPath(points: StrikeSeriesPoint[], width: number, height: number): string {
  if (points.length < 3) return '';
  const values = points.map(point => point[1]);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || Math.max(high * 0.001, 1);
  return points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((point[1] - low) / span) * height;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');
}

function displayStrike(reading: StrikeReading): string {
  const compact = Number.isInteger(reading.strike / 10) ? String(reading.strike / 10) : (reading.strike / 10).toFixed(1);
  return `${reading.symbol} ${compact}${reading.side === 'CE' ? 'C' : 'PE'}`;
}

function fullStrike(reading: StrikeReading): string {
  return `${reading.symbol} ${reading.strike}${reading.side === 'CE' ? 'C' : 'PE'}`;
}

function markCode(symbol: string): string {
  return symbol.replace(/[^A-Z]/g, '').slice(0, 2).toUpperCase();
}

function tileBuildUp(reading: StrikeReading): string {
  if (reading.oi === null) return 'No OI';
  if (reading.premiumChangePct === null) return 'Awaiting baseline';
  return buildUpText({ buildUp: reading.buildUp, futures: 'read' });
}

function tileCurveLabel(curve: CurveData): string {
  if (curve.reason === 'few') return 'Too few minutes yet for a line';
  if (curve.reason === 'baseline') return 'Baseline unavailable for this window';
  return '';
}

function tileBoxes(readings: StrikeReading[], plotTop: number, zeroY: number, plotBottom: number, neutralHeight: number, tileWidth: number): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const groups = [
    { list: readings.filter(item => item.direction === 'up'), y: (row: number) => plotTop + row * TILE_PITCH + 2 },
    { list: readings.filter(item => item.direction === 'flat'), y: (row: number) => zeroY - neutralHeight / 2 + row * TILE_PITCH + 2 },
    { list: readings.filter(item => item.direction === 'down'), y: (row: number) => plotBottom - (row + 1) * TILE_PITCH + 2 },
  ];
  for (const group of groups) {
    group.list.forEach((reading, index) => {
      const column = index % TILE_COLUMNS;
      const row = Math.floor(index / TILE_COLUMNS);
      boxes.set(reading.key, { x: TILES_X + column * (tileWidth + TILE_GAP), y: group.y(row), width: tileWidth, height: TILE_HEIGHT });
    });
  }
  return boxes;
}

function StrikeTile({ reading, box, curve }: { reading: StrikeReading; box: Box; curve: CurveData }) {
  const tone = reading.direction === 'unknown' ? 'unknown' : reading.direction;
  const name = displayStrike(reading);
  const clipped = name.length > 20 ? `${name.slice(0, 19)}…` : name;
  const buildUp = tileBuildUp(reading);
  const spark = sparkPath(curve.spark, 32, 8);
  const description = `${fullStrike(reading)}, premium ${pctText(reading.premiumChangePct)} (${signedText(reading.premiumChange)}), ${buildUp}`;

  return (
    <g className={`strike-tile is-${tone}`} transform={`translate(${box.x} ${box.y})`} role="listitem" aria-label={description} style={heatStyle(reading.premiumChangePct)}>
      <title>{description}</title>
      <rect className="strike-tile__body" width={box.width} height={box.height} rx="6" />
      <rect className="strike-tile__mark" x="7" y="7" width="16" height="16" rx="4" />
      <text className="strike-tile__mark-code" x="15" y="18" textAnchor="middle">{markCode(reading.symbol)}</text>
      <text className="strike-tile__name" x="27" y="12">{clipped}</text>
      <text className="strike-tile__pct" x={box.width - 7} y="12" textAnchor="end">{pctText(reading.premiumChangePct)}</text>
      {curve.reason ? (
        <text className="strike-tile__note" x="27" y="25">{tileCurveLabel(curve)}</text>
      ) : (
        <>
          <text className="strike-tile__bu" x="27" y="25">{buildUp}</text>
          {spark && <path className="strike-tile__spark" d={spark} transform={`translate(${box.width - 40} 18)`} />}
        </>
      )}
    </g>
  );
}

export function StrikeFlowDiagram({ flow, readings, window, upCards, downCards, cardTimeframes, onCardTimeframeChange, onOpenCard }: StrikeFlowDiagramProps) {
  const up = readings.filter(reading => reading.direction === 'up');
  const flat = readings.filter(reading => reading.direction === 'flat');
  const down = readings.filter(reading => reading.direction === 'down');
  const rowCount = (count: number) => Math.ceil(count / TILE_COLUMNS);
  const halfHeight = Math.max(MIN_HALF, Math.max(rowCount(up.length), rowCount(down.length)) * TILE_PITCH);
  const neutralHeight = flat.length ? Math.max(TILE_PITCH, rowCount(flat.length) * TILE_PITCH) : 18;
  const plotTop = TOP;
  const plotBottom = plotTop + halfHeight * 2 + neutralHeight;
  const zeroY = plotTop + halfHeight + neutralHeight / 2;
  const height = plotBottom + 46;
  const tileWidth = (WIDTH - TILES_X - 18 - TILE_GAP * (TILE_COLUMNS - 1)) / TILE_COLUMNS;
  const boxes = tileBoxes(readings, plotTop, zeroY, plotBottom, neutralHeight, tileWidth);
  const { open, close, start, end } = chartBounds(flow.date, readings, flow, window);
  const span = Math.max(1, end - start);
  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const xOf = (at: number) => PLOT_LEFT + ((at - start) / span) * plotWidth;
  const half = Math.min(zeroY - plotTop, plotBottom - zeroY);
  const curves = readings.map(reading => ({ reading, curve: curveFor(reading, window, start, end) }));
  const drawable = curves.filter((entry): entry is DrawableCurve => entry.curve.line !== null);
  const reference = spotLine(flow, start, end, window);
  const walls: StrikeWalls = strikeWalls(flow);
  const spotDayChangePct = spotChangeForWindow(flow, 'day');
  const plottedValues = [
    ...drawable.flatMap(entry => entry.curve.line.v),
    ...(reference.line?.v ?? []),
  ];
  const floorPct = BUILD_UP_NOISE_FLOOR[BUILD_UP_TIMEFRAME[window]].pricePct;
  const reach = roundedReach(axisReach(plottedValues, floorPct));
  const yOf = compressedScale(reach, zeroY, half);
  const ticks = compressedTicks(reach, half);
  const floorY = yOf(floorPct);
  const floorBottom = yOf(-floorPct);
  const gate = gateRows(
    drawable.filter(entry => entry.reading.direction === 'up').map(entry => entry.reading.key),
    drawable.filter(entry => entry.reading.direction === 'flat').map(entry => entry.reading.key),
    drawable.filter(entry => entry.reading.direction === 'down').map(entry => entry.reading.key),
    plotTop,
    plotBottom,
    { share: 0.18, maxPitch: 3, flatShare: 0.08 },
  );
  const tickWindow = TICK_WINDOW[window];
  const timeMarks = [...new Set([start, ...timeTicks(start, end, plotWidth, tickWindow), end])].sort((a, b) => a - b);
  const spotPct = reference.changePct;
  const measured = readings.filter(reading => reading.premiumChangePct !== null);
  const dotReach = Math.max(0.5, Math.ceil((Math.max(0, ...measured.map(reading => Math.abs(reading.premiumChangePct ?? 0)))) * 2) / 2);

  const card = (reading: StrikeReading) => {
    const id = `${flow.symbol}:${reading.key}`;
    return (
      <StrikeFlowCard
        key={id}
        flow={flow}
        reading={reading}
        window={window}
        walls={walls}
        spotDayChangePct={spotDayChangePct}
        timeframe={cardTimeframes[id] ?? 'auto'}
        onTimeframeChange={timeframe => onCardTimeframeChange(id, timeframe)}
        onOpen={() => onOpenCard(reading)}
      />
    );
  };

  return (
    <div className="strike-flow__diagram" aria-label="Strike momentum diagram">
      <div className="strike-flow__diagram-scroll">
        <div className="strike-flow__board">
          <svg className="strike-diagram" width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`${flow.symbol} strike premium changes for ${flow.date}, ${window} window`}>
            <defs>
              <linearGradient id="strike-axis-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop className="strike-axis__up" offset="0%" />
                <stop className="strike-axis__mid" offset="50%" />
                <stop className="strike-axis__down" offset="100%" />
              </linearGradient>
            </defs>

            {/* Distribution strip, inside the plot's top band like the reference. */}
            <g aria-hidden="true">
              <line className="strike-diagram__dist-axis" x1={PLOT_LEFT} x2={PLOT_LEFT + 430} y1="26" y2="26" />
              <line className="strike-diagram__dist-zero" x1={PLOT_LEFT + 215} x2={PLOT_LEFT + 215} y1="10" y2="40" />
              <text className="strike-diagram__dist-tick" x={PLOT_LEFT} y="54">{`−${dotReach}%`}</text>
              <text className="strike-diagram__dist-tick" x={PLOT_LEFT + 215} y="54" textAnchor="middle">0</text>
              <text className="strike-diagram__dist-tick" x={PLOT_LEFT + 430} y="54" textAnchor="end">{`+${dotReach}%`}</text>
              {measured.map(reading => {
                const value = reading.premiumChangePct ?? 0;
                const tone = reading.direction === 'up' || reading.direction === 'down' ? reading.direction : 'flat';
                const x = PLOT_LEFT + 215 + (value / dotReach) * 215;
                return <circle key={`dot-${reading.key}`} className={`strike-diagram__dist-dot is-${tone}`} cx={x} cy={tone === 'up' ? 20 - (reading.key.length % 3) * 3 : tone === 'down' ? 30 + (reading.key.length % 3) * 3 : 25} r="2.4"><title>{`${fullStrike(reading)} ${pctText(reading.premiumChangePct)}`}</title></circle>;
              })}
            </g>

            <rect className="strike-diagram__upper" x={PLOT_LEFT} y={plotTop} width={WIDTH - PLOT_LEFT - 12} height={zeroY - plotTop} />
            <rect className="strike-diagram__lower" x={PLOT_LEFT} y={zeroY} width={WIDTH - PLOT_LEFT - 12} height={plotBottom - zeroY} />
            <rect className="mf-dg__floor" x={PLOT_LEFT} y={floorY} width={WIDTH - PLOT_LEFT - 12} height={floorBottom - floorY} />

            {ticks.map(tick => (
              <g key={tick}>
                <line className="mf-dg__grid" x1={PLOT_LEFT} x2={WIDTH - 12} y1={yOf(tick)} y2={yOf(tick)} />
                <line className="mf-dg__grid" x1={PLOT_LEFT} x2={WIDTH - 12} y1={yOf(-tick)} y2={yOf(-tick)} />
                <text className="mf-dg__tick" x={PLOT_LEFT - 9} y={yOf(tick) + 3} textAnchor="end">{pctText(tick, 1)}</text>
                <text className="mf-dg__tick" x={PLOT_LEFT - 9} y={yOf(-tick) + 3} textAnchor="end">{pctText(-tick, 1)}</text>
              </g>
            ))}
            <line className="mf-dg__zero" x1={PLOT_LEFT} x2={WIDTH - 12} y1={zeroY} y2={zeroY} />
            <text className="mf-dg__tick is-zero" x={PLOT_LEFT - 9} y={zeroY + 4} textAnchor="end">0%</text>
            <rect x="17" y={plotTop} width="5" height={plotBottom - plotTop} rx="2.5" fill="url(#strike-axis-gradient)" />
            <text className="mf-dg__tick" x="28" y={plotTop + 4}>{pctText(reach, 1)}</text>
            <text className="mf-dg__tick" x="28" y={plotBottom + 4}>{pctText(-reach, 1)}</text>

            {timeMarks.map(at => (
              <g key={at}>
                <line className="mf-dg__grid is-time" x1={xOf(at)} x2={xOf(at)} y1={plotTop} y2={plotBottom} />
                <text className="mf-dg__tick" x={xOf(at)} y={plotBottom + 22} textAnchor={at === start ? 'start' : at === end ? 'end' : 'middle'}>{clockOf(at)}</text>
              </g>
            ))}
            {close >= start && close <= end && <line className="strike-diagram__close" x1={xOf(close)} x2={xOf(close)} y1={plotTop} y2={plotBottom} />}

            <g className="mf-dg__gate is-up"><rect x={GATE_LEFT} y={plotTop} width={GATE_RIGHT - GATE_LEFT} height={Math.max(1, gate.upEnd - plotTop)} rx="12" /><path d={`M${GATE_LEFT + 3},${plotTop}V${gate.upEnd}`} /></g>
            <g className="mf-dg__gate"><rect x={GATE_LEFT} y={gate.flatTop} width={GATE_RIGHT - GATE_LEFT} height={Math.max(1, gate.flatBottom - gate.flatTop)} rx="10" /></g>
            <g className="mf-dg__gate is-down"><rect x={GATE_LEFT} y={gate.downStart} width={GATE_RIGHT - GATE_LEFT} height={Math.max(1, plotBottom - gate.downStart)} rx="12" /><path d={`M${GATE_RIGHT - 3},${gate.downStart}V${plotBottom}`} /></g>

            {reference.line && <path className={`strike-diagram__spot ${spotPct != null && spotPct > 0 ? 'is-up' : spotPct != null && spotPct < 0 ? 'is-down' : 'is-flat'}`} d={pathOf(reference.line, xOf, yOf)} />}
            {drawable.map(({ reading, curve }, index) => {
              const line = curve.line;
              const last = line.t.length - 1;
              const endX = xOf(line.t[last]);
              const endY = yOf(line.v[last]);
              const gateY = gate.rows.get(reading.key) ?? endY;
              const box = boxes.get(reading.key);
              const targetY = box ? box.y + box.height / 2 : gateY;
              const path = `${pathOf(line, xOf, yOf)}${sCurveOn(endX, endY, GATE_LEFT, gateY, 0.38)}L${GATE_RIGHT},${gateY.toFixed(1)}`;
              const connector = box ? sCurve(GATE_RIGHT, gateY, box.x, targetY, 0.55) : '';
              return (
                <g key={reading.key}>
                  <path className={`mf-dg__faint is-${reading.direction}`} d={path} style={{ '--i': index } as CSSProperties} />
                  <path className={`mf-dg__conn is-${reading.direction}`} d={connector} />
                  <circle className="mf-dg__node" cx={endX} cy={endY} r="2.3" />
                </g>
              );
            })}
            {readings.filter(reading => reading.direction !== 'unknown').map(reading => {
              const box = boxes.get(reading.key);
              const curve = curves.find(entry => entry.reading.key === reading.key)?.curve;
              return box && curve ? <StrikeTile key={reading.key} reading={reading} box={box} curve={curve} /> : null;
            })}
            <text className="strike-diagram__group strike-diagram__group--up" x={TILES_X} y={plotTop - 9}>UP · {up.length}</text>
            {flat.length > 0 && <text className="strike-diagram__group" x={TILES_X} y={zeroY - neutralHeight / 2 - 7}>FLAT · {flat.length}</text>}
            <text className="strike-diagram__group strike-diagram__group--down" x={TILES_X} y={plotBottom + 12}>DOWN · {down.length}</text>
            {!drawable.length && <text className="strike-diagram__empty" x={(PLOT_LEFT + PLOT_RIGHT) / 2} y={zeroY - 8} textAnchor="middle">No contract has enough baseline data to draw a line yet.</text>}

            {/* The underlying's own reference, labelled inside the plot like the reference's NIFTY chip. */}
            <g transform={`translate(${PLOT_LEFT + 8} ${plotBottom - 28})`}>
              <rect className="strike-diagram__spot-chip" width="250" height="22" rx="6" />
              <line className={`strike-diagram__spot-swatch ${spotPct != null && spotPct > 0 ? 'is-up' : spotPct != null && spotPct < 0 ? 'is-down' : 'is-flat'}`} x1="7" x2="31" y1="11" y2="11" />
              <text className="strike-diagram__spot-chip-text" x="38" y="15">{flow.symbol} {pctText(spotPct)} · close {clockOf(close)}</text>
            </g>
          </svg>
          <aside className="strike-flow__board-cards" aria-label="Top strike movers">
            <div className="strike-flow__board-cards-group is-up">
              {upCards.map(card)}
              {!upCards.length && <p className="strike-flow__cards-empty">No measured premium rises above the noise floor.</p>}
            </div>
            <div className="strike-flow__board-cards-group is-down">
              {downCards.map(card)}
              {!downCards.length && <p className="strike-flow__cards-empty">No measured premium falls below the noise floor.</p>}
            </div>
          </aside>
        </div>
      </div>
      <span className="sr-only">Chart session opens {clockOf(open)} and uses the underlying previous close as its day reference.</span>
    </div>
  );
}
