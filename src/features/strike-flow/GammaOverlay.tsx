import type { GammaProfile } from '../market-flow/gammaModel';
import type { AtrSummary } from '../market-flow/atrModel';

export interface GammaProfileView {
  symbol: string;
  spot: number;
  profile: GammaProfile;
  atr?: AtrSummary | null;
}

interface StrikeGex {
  strike: number;
  gex: number;
  sides: string[];
}

function netByStrike(profile: GammaProfile): StrikeGex[] {
  const grouped = new Map<number, StrikeGex>();
  for (const row of profile.strikes) {
    const item = grouped.get(row.K) ?? { strike: row.K, gex: 0, sides: [] };
    item.gex += row.gex;
    item.sides.push(row.side);
    grouped.set(row.K, item);
  }
  return [...grouped.values()].sort((a, b) => a.strike - b.strike);
}

function GexProfileChart({ view }: { view: GammaProfileView }) {
  const points = netByStrike(view.profile);
  if (!points.length) return null;
  const width = 640;
  const height = 156;
  const left = 28;
  const right = width - 18;
  const zeroY = 72;
  const barHeight = 50;
  const maxGex = Math.max(...points.map(point => Math.abs(point.gex)), 1);
  const minStrike = points[0].strike;
  const maxStrike = points.at(-1)!.strike;
  const range = maxStrike - minStrike || 1;
  const x = (strike: number) => left + ((strike - minStrike) / range) * (right - left);
  const barWidth = Math.max(3, Math.min(12, ((right - left) / points.length) * 0.62));
  const topThree = new Set(points.slice().sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 3).map(point => point.strike));
  const flipLevel = Number.isFinite(view.profile.flipLevel) ? view.profile.flipLevel : null;
  const flipX = flipLevel == null ? null : x(flipLevel);
  const rawDistance = flipLevel != null && Number.isFinite(view.spot) && view.atr?.atr != null && Number.isFinite(view.atr.atr) && view.atr.atr > 0
    ? Math.abs(view.spot - flipLevel) / view.atr.atr
    : null;
  const distance = rawDistance != null && Number.isFinite(rawDistance) ? rawDistance : null;
  const flipSuffix = distance == null ? '' : ` · ${distance.toFixed(1)}×ATR${distance <= 1 ? ' (one bar)' : distance > 2 ? ' (far)' : ''}`;

  return (
    <svg className="gamma-overlay__chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${view.symbol} net gamma exposure by strike`}>
      <line className="gamma-overlay__zero" x1={left} x2={right} y1={zeroY} y2={zeroY} />
      {flipX != null && flipX >= left && flipX <= right && <>
        <line className="gamma-overlay__flip" x1={flipX} x2={flipX} y1={12} y2={height - 24} />
        <text className="gamma-overlay__flip-label" x={flipX} y={11} textAnchor="middle">FLIP {flipLevel}{flipSuffix}</text>
      </>}
      {points.map(point => {
        const bar = Math.max(1, (Math.abs(point.gex) / maxGex) * barHeight);
        const barX = x(point.strike) - barWidth / 2;
        const positive = point.gex >= 0;
        return (
          <g key={point.strike}>
            <rect className={`gamma-overlay__bar ${positive ? 'is-positive' : 'is-negative'}`} x={barX} y={positive ? zeroY - bar : zeroY} width={barWidth} height={bar} rx="1">
              <title>{`${point.strike}: ${point.gex >= 0 ? '+' : '−'}${Math.abs(point.gex).toFixed(0)} GEX · ${point.sides.join('/')}`}</title>
            </rect>
            {topThree.has(point.strike) && <text className="gamma-overlay__strike-label" x={x(point.strike)} y={positive ? zeroY - bar - 5 : zeroY + bar + 13} textAnchor="middle">{point.strike}</text>}
          </g>
        );
      })}
      <text className="gamma-overlay__axis-label" x={left} y={height - 3} textAnchor="start">{minStrike}</text>
      <text className="gamma-overlay__axis-label" x={right} y={height - 3} textAnchor="end">{maxStrike}</text>
      <text className="gamma-overlay__axis-label" x={left} y={zeroY - 4} textAnchor="start">+ GEX</text>
      <text className="gamma-overlay__axis-label" x={left} y={zeroY + 13} textAnchor="start">− GEX</text>
    </svg>
  );
}

export function GammaRegimeChips({ profiles }: { profiles: GammaProfileView[] }) {
  const shown = profiles.filter(view => view.profile.strikes.length > 0);
  if (!shown.length) return null;
  return (
    <span className="gamma-overlay__regimes" aria-label="Gamma regimes">
      {shown.map(view => (
        <span
          className={`gamma-overlay__regime ${view.profile.regime === 'gamma-long' ? 'is-long' : view.profile.regime === 'gamma-short' ? 'is-short' : 'is-unknown'}`}
          key={view.symbol}
          title={view.profile.regime === 'gamma-long' ? 'Gamma Long' : view.profile.regime === 'gamma-short' ? 'Gamma Short' : 'Gamma N/A'}
        >
          {view.symbol} {view.profile.regime === 'gamma-long' ? 'RANGE · dips bought, breakouts fade' : view.profile.regime === 'gamma-short' ? "TREND · breakouts run, don't fade" : 'Gamma N/A'}
        </span>
      ))}
    </span>
  );
}

export function GammaOverlay({ profiles }: { profiles: GammaProfileView[] }) {
  const shown = profiles.filter(view => view.profile.strikes.length > 0);
  if (!shown.length) return null;
  return (
    <section className="gamma-overlay" aria-label="Gamma exposure profiles">
      {shown.map(view => (
        <figure className="gamma-overlay__profile" key={view.symbol}>
          <figcaption><b>{view.symbol} GEX</b><span>spot {view.spot.toFixed(2)} · {view.profile.skipped} skipped</span></figcaption>
          <GexProfileChart view={view} />
        </figure>
      ))}
      <p className="gamma-overlay__disclaimer">Dealer positioning sign is an assumption from OI, not a fact. Educational only; not investment advice.</p>
    </section>
  );
}
