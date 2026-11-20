const BUCKETS = ['early-momentum', 'early-build-fast', 'model >=65', 'model <65', 're-entry'];
const REGIMES = ['up', 'down', 'range', 'unknown'];
const OUTCOMES = ['tgt1', 'sl', 'ambiguous', 'open', 'other'];
const RESOLVED = new Set(['tgt1', 'sl', 'ambiguous', 'other']);

export function signalBucket(card) {
  if (card?.reEntry) return 're-entry';
  if (card?.early === 'momentum') return 'early-momentum';
  if (card?.early === 'build-fast') return 'early-build-fast';
  return Number.isFinite(card?.quality) && card.quality >= 0.65 ? 'model >=65' : 'model <65';
}

export function regimeBucket(card) {
  return REGIMES.includes(card?.regime) && card.regime !== 'unknown' ? card.regime : 'unknown';
}

export function outcomeBucket(card) {
  if (!card?.outcome || card.outcome.status === 'open') return 'open';
  return OUTCOMES.includes(card.outcome.status) ? card.outcome.status : 'other';
}

function summarize(cards) {
  const outcomes = cards.map(outcomeBucket);
  const wins = outcomes.filter(status => status === 'tgt1').length;
  const stops = outcomes.filter(status => status === 'sl').length;
  const resolved = outcomes.filter(status => RESOLVED.has(status)).length;
  const rValues = cards
    .filter(card => RESOLVED.has(outcomeBucket(card)) && Number.isFinite(card?.outcome?.r))
    .map(card => card.outcome.r);
  return {
    cards: cards.length,
    resolved,
    open: outcomes.filter(status => status === 'open').length,
    tgt1: wins,
    sl: stops,
    ambiguous: outcomes.filter(status => status === 'ambiguous').length,
    other: outcomes.filter(status => status === 'other').length,
    winRate: wins + stops > 0 ? wins / (wins + stops) : null,
    netR: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) : null,
    rSamples: rValues.length,
  };
}

/** Pure cross-tab builder: it never reads or mutates the observations store. */
export function buildRegimeWinsReport(cards) {
  const source = Array.isArray(cards) ? cards : [];
  const rows = [];
  for (const bucket of BUCKETS) {
    for (const regime of REGIMES) {
      for (const outcome of OUTCOMES) {
        const group = source.filter(card => signalBucket(card) === bucket
          && regimeBucket(card) === regime && outcomeBucket(card) === outcome);
        rows.push({ bucket, regime, outcome, ...summarize(group) });
      }
    }
  }
  const bucketRegime = [];
  for (const bucket of BUCKETS) {
    for (const regime of REGIMES) {
      const group = source.filter(card => signalBucket(card) === bucket && regimeBucket(card) === regime);
      bucketRegime.push({ bucket, regime, ...summarize(group) });
    }
  }
  const dates = source.map(card => card?.date).filter(date => typeof date === 'string').sort();
  return {
    schemaVersion: 1,
    dateRange: dates.length ? { from: dates[0], to: dates.at(-1) } : null,
    totalCards: source.length,
    bucketCounts: Object.fromEntries(BUCKETS.map(bucket => [bucket, source.filter(card => signalBucket(card) === bucket).length])),
    rows,
    bucketRegime,
  };
}

export function printRegimeWinsReport(report, write = console.log) {
  write(`Regime wins · ${report.dateRange ? `${report.dateRange.from}–${report.dateRange.to}` : 'no dated cards'} · ${report.totalCards} cards`);
  write('bucket              regime   outcome    cards resolved win%   TGT1   SL   open     netR');
  for (const row of report.rows) {
    if (!row.cards) continue;
    const winRate = row.winRate == null ? '—' : `${(row.winRate * 100).toFixed(1)}%`;
    const netR = row.netR == null ? '—' : row.netR.toFixed(2);
    write(`${row.bucket.padEnd(20)} ${row.regime.padEnd(8)} ${row.outcome.padEnd(10)} ${String(row.cards).padStart(5)} ${String(row.resolved).padStart(8)} ${winRate.padStart(6)} ${String(row.tgt1).padStart(6)} ${String(row.sl).padStart(4)} ${String(row.open).padStart(6)} ${netR.padStart(8)}`);
  }
}
