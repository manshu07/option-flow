/**
 * Compare wall-priced targets with stored percentile targets over captured cards.
 *
 *   node --max-old-space-size=8192 scripts/wallTargetBacktest.mjs <fromDate> <toDate>
 *
 * Archived minute files are streamed one snapshot at a time. Only the selected
 * contract's captured closes are retained for each stored observation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { loadMoveStats } from '../server/moveStats.mjs';
import { optionIv, yearsToExpiry } from '../server/optionMath.mjs';
import { selectWallTarget } from '../server/wallTargets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'server', 'data');
const RAW = path.join(DATA, 'dhan');
const ARCHIVE = path.join(DATA, 'archives', 'dhan');
const OBS = path.join(DATA, 'observations.json');
const OUT = path.join(DATA, 'wall-target-report.json');
const DEFAULT_FROM = '2026-11-18';
const DEFAULT_TO = '2026-11-20';
const MIN_RR = Number(process.env.ADVISOR_MIN_RR ?? 2);
const MIN_TGT2_RR = 3;
const snapTick = premium => Math.round(premium * 20) / 20;

const bucketOf = card => {
  if (card.early === 'momentum') return 'early-momentum';
  if (card.early === 'build-fast') return 'early-build-fast';
  if (Number.isFinite(card.quality)) return card.quality >= 0.65 ? 'model >=65' : 'model <65';
  return 'unclassified';
};

function istMinute(at) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const hour = parts.find(part => part.type === 'hour')?.value;
  const minute = parts.find(part => part.type === 'minute')?.value;
  return hour && minute ? Number(hour) * 60 + Number(minute) : null;
}

function readRawIndex(day) {
  const file = path.join(RAW, day, 'index.json');
  if (!fs.existsSync(file)) return null;
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`Invalid raw minute index for ${day}`);
  return entries.map(([hhmm]) => String(hhmm).padStart(4, '0')).sort();
}

async function* rawMinutes(day, index) {
  const dir = path.join(RAW, day);
  for (const hhmm of index) {
    const file = path.join(dir, `${hhmm}.json`);
    try { yield JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

/**
 * Read only the top-level `minutes` object from a compact gzip archive.
 * The decompressed archive is never assembled in memory: buffering is bounded
 * to the current zlib chunk plus one minute snapshot.
 */
export async function* archivedMinutes(file) {
  const input = fs.createReadStream(file).pipe(createGunzip());
  let stage = 'search';
  let searchString = false, searchEscape = false, searchToken = '';
  let rootDepth = 0, arrayDepth = 0, keyPending = false, colonPending = false;
  let keyInString = false, keyEscape = false;
  let value = '', valueDepth = 0, valueInString = false, valueEscape = false;

  for await (const chunk of input) {
    const text = chunk.toString('utf8');
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (stage === 'search') {
        if (searchString) {
          if (searchEscape) { searchToken += char; searchEscape = false; }
          else if (char === '\\') searchEscape = true;
          else if (char === '"') {
            searchString = false;
            keyPending = rootDepth === 1 && arrayDepth === 0 && searchToken === 'minutes';
            searchToken = '';
          } else if (searchToken.length < 32) searchToken += char;
          continue;
        }
        if (keyPending) {
          if (/\s/.test(char)) continue;
          if (char === ':') { colonPending = true; keyPending = false; continue; }
          keyPending = false;
        }
        if (colonPending) {
          if (/\s/.test(char)) continue;
          colonPending = false;
          if (char === '{') { stage = 'minute-key'; continue; }
        }
        if (char === '"') { searchString = true; searchToken = ''; continue; }
        if (char === '{') rootDepth++;
        else if (char === '}') rootDepth--;
        else if (char === '[') arrayDepth++;
        else if (char === ']') arrayDepth--;
        continue;
      }

      if (stage === 'minute-key') {
        if (keyInString) {
          if (keyEscape) keyEscape = false;
          else if (char === '\\') keyEscape = true;
          else if (char === '"') { keyInString = false; stage = 'minute-colon'; }
          continue;
        }
        if (/\s|,/.test(char)) continue;
        if (char === '}') return;
        if (char !== '"') throw new Error(`Malformed archived minutes map in ${file}`);
        keyInString = true;
        continue;
      }

      if (stage === 'minute-colon') {
        if (/\s/.test(char)) continue;
        if (char !== ':') throw new Error(`Malformed archived minute key in ${file}`);
        stage = 'minute-value';
        continue;
      }

      if (stage === 'minute-value') {
        if (/\s/.test(char)) continue;
        if (char !== '{') throw new Error(`Archived minute is not an object in ${file}`);
        stage = 'snapshot';
        value = '{';
        valueDepth = 1;
        valueInString = false;
        valueEscape = false;
        continue;
      }

      value += char;
      if (valueInString) {
        if (valueEscape) valueEscape = false;
        else if (char === '\\') valueEscape = true;
        else if (char === '"') valueInString = false;
        continue;
      }
      if (char === '"') valueInString = true;
      else if (char === '{') valueDepth++;
      else if (char === '}' && --valueDepth === 0) {
        yield JSON.parse(value);
        value = '';
        stage = 'minute-key';
      }
    }
  }
  if (stage === 'search') throw new Error(`Archive has no minutes object: ${file}`);
  if (stage === 'snapshot') throw new Error(`Truncated minute snapshot in ${file}`);
}

function allCaptureDates() {
  const raw = fs.readdirSync(RAW).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
  const archived = fs.existsSync(ARCHIVE)
    ? fs.readdirSync(ARCHIVE).filter(name => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name)).map(name => name.slice(0, 10))
    : [];
  return [...new Set([...raw, ...archived])].sort();
}

function businessDates(from, through) {
  const dates = [];
  const first = Date.parse(`${from}T00:00:00Z`);
  const last = Date.parse(`${through}T00:00:00Z`);
  for (let at = first; at <= last; at += 86_400_000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

function rowForCard(card, snapshot) {
  const series = snapshot?.series?.find(item => item?.s === card.symbol);
  const side = card.side === 'CE' ? 0 : 1;
  // Match journal.mjs rowFor verbatim: the card expiry chooses `next` only
  // when it exactly matches series.next.e, otherwise rows come from series.r.
  const rows = typeof card.expiry === 'string' && series?.next?.e === card.expiry ? series.next.r : series?.r;
  return rows?.find(row => Array.isArray(row) && row[0] === card.strike && row[1] === side) ?? null;
}

function sessionIsFull(info) {
  return Boolean(info && info.firstMinute != null && info.lastMinute != null
    && info.firstMinute <= 9 * 60 + 30 && info.lastMinute >= 15 * 60 + 30);
}

function riskOf(card) {
  return Number.isFinite(card.entry) && Number.isFinite(card.sl) && card.entry > card.sl
    ? card.entry - card.sl
    : null;
}

function replay(card, target, samples, windowComplete) {
  const risk = riskOf(card);
  if (!(Number.isFinite(target) && target > card.entry && risk > 0)) return { status: 'unavailable', r: null, eventAt: null, preTargetDip: null, gap: null, complete: false };
  let preTargetDip = 0;
  for (const sample of samples) {
    if (sample.price <= card.sl) return { status: 'sl', r: -1, eventAt: sample.at, minutesToHit: (sample.at - card.at) / 60_000, preTargetDip, gap: null, complete: true };
    if (sample.price >= target) {
      return { status: 'tgt1', r: (target - card.entry) / risk, eventAt: sample.at, minutesToHit: (sample.at - card.at) / 60_000, preTargetDip, gap: sample.price - target, complete: true };
    }
    preTargetDip = Math.min(preTargetDip, sample.price - card.entry);
  }
  if (samples.length && windowComplete) {
    const last = samples.at(-1);
    return { status: 'open', r: (last.price - card.entry) / risk, eventAt: null, preTargetDip, gap: null, complete: true };
  }
  return { status: 'censored', r: null, eventAt: null, preTargetDip, gap: null, complete: false };
}

function classification(cards) {
  const counts = { 'early-momentum': 0, 'early-build-fast': 0, 'model >=65': 0, 'model <65': 0, unclassified: 0 };
  for (const card of cards) counts[bucketOf(card)]++;
  return counts;
}

function reportBucket(rows) {
  const result = {};
  for (const bucket of ['early-momentum', 'early-build-fast', 'model >=65', 'model <65', 'unclassified']) {
    const group = rows.filter(row => row.bucket === bucket);
    const paired = group.filter(row => row.percentile.complete && row.wall.complete && row.wallTarget != null);
    const noTrade = group.filter(row => row.projectedNoTrade);
    const sum = key => paired.reduce((total, row) => total + row[key].r, 0);
    const oldStops = paired.filter(row => row.percentile.status === 'sl').length;
    const wallStops = paired.filter(row => row.wall.status === 'sl').length;
    result[bucket] = {
      cards: group.length,
      headlinePaired: paired.length,
      pairedTrades: paired.length,
      wallTargets: group.filter(row => row.wallTarget != null).length,
      noWallTarget: group.filter(row => row.wallTarget == null).length,
      noTrade: noTrade.length,
      missingWallData: group.filter(row => row.missingWallData).length,
      percentileHitRate: paired.length ? paired.filter(row => row.percentile.status === 'tgt1').length / paired.length : null,
      wallHitRate: paired.length ? paired.filter(row => row.wall.status === 'tgt1').length / paired.length : null,
      percentileStopRate: paired.length ? oldStops / paired.length : null,
      wallStopRate: paired.length ? wallStops / paired.length : null,
      percentileNetR: paired.length ? sum('percentile') : null,
      wallNetR: paired.length ? sum('wall') : null,
      netRDelta: paired.length ? sum('wall') - sum('percentile') : null,
      beatsGate: paired.length ? sum('wall') > sum('percentile') && wallStops <= oldStops : null,
    };
  }
  return result;
}

export async function runWallTargetBacktest({ observationsPath = OBS, reportPath = OUT, from = DEFAULT_FROM, to = DEFAULT_TO, minRR = MIN_RR } = {}) {
  const store = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
  const cards = (store.cards ?? []).filter(card => card.date >= from && card.date <= to)
    .filter(card => Number.isFinite(card.at) && Number.isFinite(card.spot) && card.spot > 0)
    .sort((a, b) => a.at - b.at);
  const statsCache = new Map();
  const prepared = cards.map(card => {
    const moveStats = statsCache.has(card.symbol) ? statsCache.get(card.symbol) : loadMoveStats(path.join(DATA, 'move-stats'), card.symbol);
    statsCache.set(card.symbol, moveStats);
    const selection = selectWallTarget({
      spot: card.spot,
      entry: card.entry,
      sl: card.sl,
      expiryDate: card.expiry,
      holdDays: Number.isFinite(card.holdDays) ? card.holdDays : 0,
      decayPerDay: card.thetaDay,
      moveStats,
      walls: { support: card.support, resistance: card.resistance },
      gamma: card.gamma,
      contract: { strike: card.strike, side: card.side, iv: card.iv, at: card.at },
      minRR,
      minTgt2RR: MIN_TGT2_RR,
    });
    const years = yearsToExpiry(card.expiry, card.at);
    const iv = years ? optionIv({ premium: card.entry, spot: card.spot, strike: card.strike, years, side: card.side, captured: card.iv }) : null;
    const ivSource = Number.isFinite(card.iv) && card.iv >= 5 && card.iv <= 150 ? 'stored card IV'
      : Number.isFinite(iv) && iv > 0 ? 'gamma-inverted fallback'
        : 'unavailable; no IV assumption used';
    return { card, bucket: bucketOf(card), moveStats, selection, ivSource, samples: [] };
  });
  const bySymbol = new Map();
  for (const item of prepared) {
    const list = bySymbol.get(item.card.symbol) ?? [];
    list.push(item);
    bySymbol.set(item.card.symbol, list);
  }

  const available = allCaptureDates();
  const datesNeeded = new Set();
  for (const item of prepared) {
    const through = typeof item.card.holdTill === 'string' ? item.card.holdTill : item.card.date;
    for (const date of businessDates(item.card.date, through)) {
      if (available.includes(date)) datesNeeded.add(date);
    }
  }
  const sessionCoverage = {};
  for (const date of [...datesNeeded].sort()) {
    const index = readRawIndex(date);
    const archiveFile = path.join(ARCHIVE, `${date}.json.gz`);
    const isRaw = Boolean(index);
    const info = { source: isRaw ? 'raw' : 'archive', snapshots: 0, firstMinute: null, lastMinute: null };
    const consume = snapshot => {
      if (snapshot?.date !== date || !Number.isFinite(snapshot.t) || !Array.isArray(snapshot.series)) return;
      const minute = istMinute(snapshot.t);
      if (minute == null) return;
      info.snapshots++;
      info.firstMinute = info.firstMinute == null ? minute : Math.min(info.firstMinute, minute);
      info.lastMinute = info.lastMinute == null ? minute : Math.max(info.lastMinute, minute);
      for (const series of snapshot.series) {
        const interested = bySymbol.get(series?.s);
        if (!interested) continue;
        for (const item of interested) {
          if (date < item.card.date || date > (item.card.holdTill ?? item.card.date) || snapshot.t < item.card.at) continue;
          const row = rowForCard(item.card, { series: [series] });
          const price = Number(row?.[2]);
          if (!(price > 0)) continue;
          item.samples.push({ at: snapshot.t, date, price });
        }
      }
    };
    if (isRaw) {
      for await (const snapshot of rawMinutes(date, index)) consume(snapshot);
    } else if (fs.existsSync(archiveFile)) {
      for await (const snapshot of archivedMinutes(archiveFile)) consume(snapshot);
    }
    sessionCoverage[date] = { ...info, fullSession: sessionIsFull(info) };
    console.log(`${date}: ${info.snapshots} ${info.source} minutes · ${info.firstMinute == null ? 'no start' : info.firstMinute}–${info.lastMinute ?? 'no end'} IST · ${sessionIsFull(info) ? 'full session' : 'partial/censored'}`);
  }

  const allCaptureDatesSet = new Set(available);
  const rows = prepared.map(item => {
    const card = item.card;
    const holdTill = typeof card.holdTill === 'string' ? card.holdTill : card.date;
    const expectedDates = businessDates(card.date, holdTill);
    const missingDates = expectedDates.filter(date => !sessionIsFull(sessionCoverage[date]));
    const windowComplete = missingDates.length === 0 && expectedDates.every(date => allCaptureDatesSet.has(date));
    item.samples.sort((a, b) => a.at - b.at);
    const percentile = replay(card, card.tgt1, item.samples, windowComplete);
    const rawWallTarget = item.selection.tgt1;
    const wallTarget = Number.isFinite(rawWallTarget) ? snapTick(rawWallTarget) : null;
    const wall = replay(card, wallTarget, item.samples, windowComplete);
    const auditCandidates = item.selection.candidates.map(candidate => ({
      level: candidate.strike,
      oi: candidate.oi,
      kind: candidate.kind,
      premium: Number.isFinite(candidate.premium) ? snapTick(candidate.premium) : null,
      rewardRisk: candidate.rr,
      reachPercentile: candidate.reachPercentile,
      rejected: candidate.reject,
    }));
    return {
      id: card.id,
      date: card.date,
      symbol: card.symbol,
      contract: `${card.strike}${card.side}`,
      expiry: card.expiry,
      bucket: item.bucket,
      holdDays: Number.isFinite(card.holdDays) ? card.holdDays : 0,
      holdTill,
      windowComplete,
      missingDates,
      observedSamples: item.samples.length,
      percentileTarget: card.tgt1,
      wallTarget,
      percentileRewardRisk: riskOf(card) > 0 && Number.isFinite(card.tgt1) ? (card.tgt1 - card.entry) / riskOf(card) : null,
      wallFallbackPassesRR: riskOf(card) > 0 && Number.isFinite(card.tgt1) && (card.tgt1 - card.entry) / riskOf(card) >= minRR,
      projectedNoTrade: wallTarget == null && !(riskOf(card) > 0 && Number.isFinite(card.tgt1) && (card.tgt1 - card.entry) / riskOf(card) >= minRR),
      wallLevel: item.selection.tgt1Wall,
      wallTgt2: Number.isFinite(item.selection.tgt2) ? snapTick(item.selection.tgt2) : null,
      ivSource: item.ivSource,
      wallReject: item.selection.reject,
      missingWallData: item.selection.candidates.length === 0,
      p85MovePct: item.selection.p85MovePct ?? null,
      candidates: auditCandidates,
      percentile,
      wall,
    };
  });

  const paired = rows.filter(row => row.date < to && sessionCoverage[row.date]?.fullSession
    && row.percentile.complete && row.wall.complete && row.wallTarget != null);
  const headlineRows = rows.filter(row => row.date < to && sessionCoverage[row.date]?.fullSession
    && (paired.includes(row) || (row.wallTarget == null && row.windowComplete)));
  const provisionalRows = rows.filter(row => !headlineRows.includes(row));
  const compare = group => {
    const sample = group.filter(row => row.percentile.complete && row.wall.complete && row.wallTarget != null);
    const net = strategy => sample.reduce((sum, row) => sum + row[strategy].r, 0);
    return {
      cards: group.length,
      pairedTrades: sample.length,
      noTrade: group.filter(row => row.projectedNoTrade).length,
      noWallTarget: group.filter(row => row.wallTarget == null).length,
      missingWallData: group.filter(row => row.missingWallData).length,
      percentileHits: sample.filter(row => row.percentile.status === 'tgt1').length,
      wallHits: sample.filter(row => row.wall.status === 'tgt1').length,
      percentileStops: sample.filter(row => row.percentile.status === 'sl').length,
      wallStops: sample.filter(row => row.wall.status === 'sl').length,
      percentileHitRate: sample.length ? sample.filter(row => row.percentile.status === 'tgt1').length / sample.length : null,
      wallHitRate: sample.length ? sample.filter(row => row.wall.status === 'tgt1').length / sample.length : null,
      percentileStopRate: sample.length ? sample.filter(row => row.percentile.status === 'sl').length / sample.length : null,
      wallStopRate: sample.length ? sample.filter(row => row.wall.status === 'sl').length / sample.length : null,
      percentileNetR: sample.length ? net('percentile') : null,
      wallNetR: sample.length ? net('wall') : null,
      netRDelta: sample.length ? net('wall') - net('percentile') : null,
      beatsGate: sample.length
        ? net('wall') > net('percentile')
          && sample.filter(row => row.wall.status === 'sl').length <= sample.filter(row => row.percentile.status === 'sl').length
        : null,
      buckets: reportBucket(group),
    };
  };
  const byDate = Object.fromEntries([...new Set(headlineRows.map(row => row.date))].sort().map(date => [date, compare(headlineRows.filter(row => row.date === date))]));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dates: { from, to },
    configuration: { minRewardRisk: minRR, tgt2MinRewardRisk: MIN_TGT2_RR, closeOnly: true, fixedStop: true },
    methodology: {
      targetBaseline: 'existing stored TGT1 premium (card.tgt1), re-played with the same card expiry, fixed SL, and captured LTP close timeline',
      wallTarget: 'selectWallTarget shared policy, p85 favorable-move cap; selected premium snapped to ₹0.05 before replay',
      noTrade: 'No wall target is counted separately; projected no-trade applies the S2 fallback rule and counts only when the existing fallback TGT1 also fails min R:R.',
      netR: 'target reward / (entry - unchanged SL); SL = -1R; a fully covered open trade is marked to its last captured close',
      holdWindow: 'card.at through holdTill inclusive; an event resolves its outcome, otherwise every expected business session must have full-session capture',
      fullSessionDefinition: 'first observed capture at or before 09:30 IST and last at or after 15:30 IST',
      archives: 'gzip minutes streamed one snapshot at a time; only matching card-contract closes are retained',
      contractRows: 'journal.mjs rowFor rule copied verbatim: matching series.next.e selects next.r, otherwise series.r',
      censored: 'partial session or missing hold-window date never enters the headline; report separately as provisional/censored',
      reachPercentile: 'interpolated percentile implied by existing entry-time moveStats reachRate for each candidate spot level',
    },
    sessionCoverage,
    bucketCounts: classification(cards),
    headline: {
      description: `Only cards from sessions whose captures span the full day, with paired resolved outcomes; censored multi-day windows and partial session files are excluded.`,
      ...compare(headlineRows),
      byDate,
      beatsPercentileNetR: paired.length > 0 && netRGreater(paired),
      beatsGatePerBucket: Object.fromEntries(Object.entries(reportBucket(headlineRows)).map(([bucket, stats]) => [bucket, stats.beatsGate])),
      gateConclusion: paired.length
        ? 'Measured net R and stop-rate gate shown per bucket; interpret alongside the small paired sample and censored-window counts.'
        : 'No fully paired target sample is available; the wall policy has not demonstrated an improvement.',
      cards: headlineRows,
    },
    provisional: {
      description: `Cards on/after the partial-session end date (${to}) and every censored hold window; these do not contribute to headline comparison.`,
      ...compare(provisionalRows),
      byDate: Object.fromEntries([...new Set(provisionalRows.map(row => row.date))].sort().map(date => [date, compare(provisionalRows.filter(row => row.date === date))])),
      cards: provisionalRows,
    },
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printReport(report);
  console.log(`\nreport → ${path.relative(ROOT, reportPath)}`);
  return report;
}

function netRGreater(paired) {
  return paired.reduce((sum, row) => sum + row.wall.r - row.percentile.r, 0) > 0;
}

function printReport(report) {
  const print = (label, result) => {
    const sampleCount = result.pairedTrades ?? result.headlinePaired ?? 0;
    const oldRate = result.percentileHitRate == null ? 'n/a' : `${(result.percentileHitRate * 100).toFixed(1)}%`;
    const wallRate = result.wallHitRate == null ? 'n/a' : `${(result.wallHitRate * 100).toFixed(1)}%`;
    const oldStops = result.percentileStopRate == null ? 'n/a' : `${(result.percentileStopRate * 100).toFixed(1)}%`;
    const wallStops = result.wallStopRate == null ? 'n/a' : `${(result.wallStopRate * 100).toFixed(1)}%`;
    const oldR = result.percentileNetR == null ? 'n/a' : result.percentileNetR.toFixed(2);
    const wallR = result.wallNetR == null ? 'n/a' : result.wallNetR.toFixed(2);
    const deltaR = result.netRDelta == null ? 'n/a' : result.netRDelta.toFixed(2);
    console.log(`${label.padEnd(23)} n=${String(sampleCount).padStart(3)}  percentile ${oldRate.padStart(6)} SL ${oldStops.padStart(6)} / ${oldR.padStart(7)}R  wall ${wallRate.padStart(6)} SL ${wallStops.padStart(6)} / ${wallR.padStart(7)}R  Δ ${deltaR.padStart(7)}R  no-wall=${result.noWallTarget} fallback-no-trade=${result.noTrade}`);
  };
  console.log('\nWall target vs existing stored TGT1 (paired, covered outcomes)');
  print('HEADLINE 18–19', report.headline);
  for (const [date, result] of Object.entries(report.headline.byDate)) print(date, result);
  for (const [bucket, result] of Object.entries(report.headline.buckets)) print(`  ${bucket}`, result);
  console.log('\nCensored / provisional (excluded from headline)');
  print('PROVISIONAL', report.provisional);
  for (const [date, result] of Object.entries(report.provisional.byDate)) print(date, result);
  const allCards = [...report.headline.cards, ...report.provisional.cards];
  console.log(`wall data missing=${report.headline.missingWallData + report.provisional.missingWallData}; total cards=${allCards.length}; IV sources: ${JSON.stringify(Object.fromEntries([...new Set(allCards.map(card => card.ivSource))].map(source => [source, allCards.filter(card => card.ivSource === source).length])))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
  if (args.length !== 2 || !args.every(validDate) || args[0] > args[1]) {
    console.error('usage: node --max-old-space-size=8192 scripts/wallTargetBacktest.mjs <fromDate> <toDate>');
    process.exitCode = 1;
  } else {
    runWallTargetBacktest({ from: args[0], to: args[1] }).catch(error => {
      console.error(`wall target backtest failed: ${String(error?.message || error)}`);
      process.exitCode = 1;
    });
  }
}
