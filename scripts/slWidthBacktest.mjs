#!/usr/bin/env node
/** Read-only, first-touch replay of stored option-card stop variants. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { archivedMinutes } from './wallTargetBacktest.mjs';
import { signalBucket } from '../server/regimeWins.mjs';
import {
  extractContractTimelines,
  extractUnderlyingTimelines,
  expectedTradingDates,
  simulateStopVariant,
  simulateUnderlyingStopPreview,
} from '../server/slWidthBacktest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'server', 'data');
const RAW = path.join(DATA, 'dhan');
const ARCHIVE = path.join(DATA, 'archives', 'dhan');
const OBSERVATIONS = path.join(DATA, 'observations.json');
const REPORT = path.join(DATA, 'sl-width-report.json');

/** Stream only selected top-level futures entries from a gzip archive. */
export async function* archivedFutures(file, symbols = null) {
  const input = fs.createReadStream(file).pipe(createGunzip());
  let stage = 'search';
  let inString = false, escaped = false, token = '';
  let objectDepth = 0, arrayDepth = 0, keyPending = false, colonPending = false;
  let keyInString = false, keyEscape = false, keyText = '';
  let entryKey = null, selected = false;
  let valueText = '', valueDepth = 0, valueInString = false, valueEscape = false;

  for await (const chunk of input) {
    const text = chunk.toString('utf8');
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (stage === 'search') {
        if (inString) {
          if (escaped) { if (token.length < 32) token += char; escaped = false; }
          else if (char === '\\') escaped = true;
          else if (char === '"') {
            inString = false;
            keyPending = objectDepth === 1 && arrayDepth === 0 && token === 'futures';
            token = '';
          } else if (token.length < 32) token += char;
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
          if (char === '{') { stage = 'entry-key'; continue; }
        }
        if (char === '"') { inString = true; token = ''; continue; }
        if (char === '{') objectDepth++;
        else if (char === '}') objectDepth--;
        else if (char === '[') arrayDepth++;
        else if (char === ']') arrayDepth--;
        continue;
      }

      if (stage === 'entry-key') {
        if (keyInString) {
          keyText += char;
          if (keyEscape) keyEscape = false;
          else if (char === '\\') keyEscape = true;
          else if (char === '"') {
            keyInString = false;
            entryKey = JSON.parse(`"${keyText.slice(0, -1)}"`);
            selected = !symbols || symbols.has(entryKey);
            stage = 'entry-colon';
          }
          continue;
        }
        if (/\s|,/.test(char)) continue;
        if (char === '}') return;
        if (char !== '"') throw new Error(`Malformed archived futures map in ${file}`);
        keyInString = true;
        keyEscape = false;
        keyText = '';
        continue;
      }

      if (stage === 'entry-colon') {
        if (/\s/.test(char)) continue;
        if (char !== ':') throw new Error(`Malformed archived futures entry in ${file}`);
        stage = 'entry-value';
        continue;
      }

      if (stage === 'entry-value') {
        if (/\s/.test(char)) continue;
        if (char !== '{') throw new Error(`Archived futures entry ${entryKey} is not an object.`);
        stage = 'entry-object';
        valueText = selected ? '{' : '';
        valueDepth = 1;
        valueInString = false;
        valueEscape = false;
        continue;
      }

      if (selected) valueText += char;
      if (valueInString) {
        if (valueEscape) valueEscape = false;
        else if (char === '\\') valueEscape = true;
        else if (char === '"') valueInString = false;
        continue;
      }
      if (char === '"') valueInString = true;
      else if (char === '{') valueDepth++;
      else if (char === '}' && --valueDepth === 0) {
        if (selected) yield [entryKey, JSON.parse(valueText)];
        stage = 'entry-key';
        valueText = '';
        entryKey = null;
        selected = false;
      }
    }
  }
  if (stage === 'entry-object') throw new Error(`Truncated archived futures entry in ${file}`);
}

export const STOP_POLICIES = [
  { key: 'baseline', label: 'Stored SL', kind: 'fixed' },
  { key: 'risk-0.75', label: 'SL 0.75× risk', kind: 'scaled', multiple: 0.75 },
  { key: 'risk-1.25', label: 'SL 1.25× risk', kind: 'scaled', multiple: 1.25 },
  { key: 'risk-1.5', label: 'SL 1.5× risk', kind: 'scaled', multiple: 1.5 },
  { key: 'breakeven-0.5', label: 'BE arm +0.5R', kind: 'breakeven', armR: 0.5 },
  { key: 'breakeven-1', label: 'BE arm +1R', kind: 'breakeven', armR: 1 },
  { key: 'close-exit', label: 'Stored SL + close exit', kind: 'fixed', closeExit: true },
];

const cardKey = (card, index) => card.id ?? JSON.stringify([card.symbol, card.date, card.at, card.expiry, card.strike, card.side, index]);

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
}

async function readRawIndex(date) {
  const file = path.join(RAW, date, 'index.json');
  try {
    const entries = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return Array.isArray(entries) ? entries.map(entry => Array.isArray(entry) ? entry[0] : entry) : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRawMinute(date, minute) {
  try { return JSON.parse(await fs.promises.readFile(path.join(RAW, date, `${minute}.json`), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function readRawFutures(date, symbol) {
  try { return JSON.parse(await fs.promises.readFile(path.join(RAW, date, 'futures', `${symbol}.json`), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function readArchiveMinutes(date) {
  const file = path.join(ARCHIVE, `${date}.json.gz`);
  try { await fs.promises.access(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return archivedMinutes(file);
}

async function readArchiveFutures(date, symbols) {
  const file = path.join(ARCHIVE, `${date}.json.gz`);
  try { await fs.promises.access(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return archivedFutures(file, symbols);
}

function summarize(cards, variantKey) {
  const simulated = cards.map(card => ({ card, result: card.variants[variantKey] }));
  const usable = simulated.filter(({ result }) => result && !['invalid', 'censored'].includes(result.status));
  const baselineWinners = new Set(cards.filter(card => card.variants.baseline.status === 'tgt1').map(card => card.id));
  const winnersLost = usable.filter(({ card, result }) => baselineWinners.has(card.id) && result.status !== 'tgt1').length;
  const statuses = ['sl', 'tgt1', 'ambiguous', 'open', 'close-exit', 'breakeven', 'censored', 'invalid'];
  const counts = Object.fromEntries(statuses.map(status => [status, simulated.filter(({ result }) => result?.status === status).length]));
  const netValues = usable.map(({ result }) => result.r).filter(Number.isFinite);
  return {
    cards: cards.length,
    sampled: usable.length,
    missingTimeline: counts.censored,
    invalid: counts.invalid,
    sl: counts.sl,
    slRate: usable.length ? counts.sl / usable.length : null,
    tgt1: counts.tgt1,
    tgt1Rate: usable.length ? counts.tgt1 / usable.length : null,
    ambiguous: counts.ambiguous,
    breakeven: counts.breakeven,
    closeExits: counts['close-exit'],
    open: counts.open,
    winnersLost,
    netR: netValues.length ? netValues.reduce((sum, value) => sum + value, 0) : null,
    rSamples: netValues.length,
    preTargetDipMean: usable.length
      ? usable.reduce((sum, { result }) => sum + (Number.isFinite(result.preTargetDip) ? result.preTargetDip : 0), 0) / usable.length
      : null,
  };
}

export function buildSlWidthReport(cards, timelines, { from, to, policies = STOP_POLICIES, underlyingTimelines = [] } = {}) {
  const graded = cards.map((card, index) => {
    const timeline = timelines[index];
    const underlyingTimeline = underlyingTimelines[index] ?? { candles: [], expectedCandles: 0, missingCandles: 0, rawCandles: 0, archiveCandles: 0 };
    const variants = Object.fromEntries(policies.map(policy => [policy.key, simulateStopVariant(timeline, policy)]));
    const underlyingPreview = simulateUnderlyingStopPreview(timeline, underlyingTimeline);
    return {
      id: cardKey(card, index),
      date: card.date,
      symbol: card.symbol,
      contract: `${card.strike}${card.side}`,
      expiry: card.expiry ?? null,
      bucket: signalBucket(card),
      regime: card.regime ?? 'unknown',
      bias: card.bias,
      entryAt: card.at,
      holdTill: card.holdTill ?? card.date,
      entry: card.entry,
      originalSl: card.sl,
      tgt1: card.tgt1,
      slSpot: Number.isFinite(card.slSpot) ? card.slSpot : Number.isFinite(card.needs?.sl?.level) ? card.needs.sl.level : null,
      storedOutcome: card.outcome?.status ?? 'open',
      coverage: {
        sampledMinutes: timeline.sampledMinutes,
        expectedMinutes: timeline.expectedMinutes,
        missingMinutes: timeline.missingMinutes,
        rawSamples: timeline.rawSamples,
        archiveSamples: timeline.archiveSamples,
      },
      preTargetDip: variants.baseline.preTargetDip,
      futuresCoverage: {
        candles: underlyingTimeline.candles.length,
        expectedCandles: underlyingTimeline.expectedCandles,
        missingCandles: underlyingTimeline.missingCandles,
        rawCandles: underlyingTimeline.rawCandles,
        archiveCandles: underlyingTimeline.archiveCandles,
      },
      underlyingPreview,
      variants,
    };
  });
  const buckets = ['early-momentum', 'early-build-fast', 'model >=65', 'model <65', 're-entry'];
  const summary = policies.map(policy => ({
    variant: policy.key,
    label: policy.label,
    overall: summarize(graded, policy.key),
    byBucket: Object.fromEntries(buckets.map(bucket => [bucket, summarize(graded.filter(card => card.bucket === bucket), policy.key)])),
  }));
  const underlyingDataCards = graded.filter(card => Number.isFinite(card.slSpot)
    && card.futuresCoverage.candles > 0 && !['missing-level', 'missing-futures'].includes(card.underlyingPreview.status));
  const underlyingCandidates = underlyingDataCards.filter(card => card.underlyingPreview.status !== 'censored');
  const underlyingSl = underlyingCandidates.filter(card => card.underlyingPreview.status === 'sl').length;
  const premiumBaselineSl = underlyingCandidates.filter(card => card.variants.baseline.status === 'sl').length;
  const underlyingTgt1 = underlyingCandidates.filter(card => card.underlyingPreview.status === 'tgt1').length;
  const premiumBaselineTgt1 = underlyingCandidates.filter(card => card.variants.baseline.status === 'tgt1').length;
  const underlyingSlByTrigger = {
    underlying: underlyingCandidates.filter(card => card.underlyingPreview.status === 'sl' && card.underlyingPreview.slTrigger === 'underlying').length,
    premium: underlyingCandidates.filter(card => card.underlyingPreview.status === 'sl' && card.underlyingPreview.slTrigger === 'premium').length,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dateRange: { from, to },
    totalCards: cards.length,
    methodology: {
      timeline: 'Timestamp-ordered captured contract premiums. Raw HHMM files win; the streamed gzip archive fills a missing raw contract-minute.',
      contractRows: 'Journal rowFor rule: card.expiry === series.next.e ? series.next.r : series.r, then strike + side.',
      touch: 'Journal cumulative day high/low is seeded from the last pre-entry row; an increment across SL and TGT1 in one sample is ambiguous. Session extremes are not used as outcomes.',
      stops: 'Scaled-stop risk is entry minus that variant stop; target R and close-exit R are renormalized to the variant risk. Breakeven uses the original risk for its arm threshold and R denominator.',
      winnersLost: 'Baseline first-touch TGT1 cards that a variant does not settle as TGT1.',
      range: 'Per-card preTargetDip is captured premium depth below entry before its first simulated terminal event.',
      dataLimit: 'Captured minutes are sampled market evidence, not exact exchange OHLC or fill confirmation. Missing samples and sessions are reported per card.',
      underlyingPreview: 'S2-only, read-only gate preview: needs.sl.level as slSpot, futures candle close breach in the card bias direction, and the −70% premium disaster backstop. This does not modify cards or journal semantics.',
    },
    variants: summary,
    underlyingPreview: {
      method: 'S2 measurement only; S4 is not implemented.',
      cardsWithSlSpot: graded.filter(card => Number.isFinite(card.slSpot)).length,
      cardsWithFutures: graded.filter(card => card.futuresCoverage.candles > 0).length,
      cardsWithUnderlyingData: underlyingDataCards.length,
      comparableCards: underlyingCandidates.length,
      partialFutureWindows: underlyingDataCards.filter(card => card.futuresCoverage.missingCandles > 0).length,
      censored: underlyingDataCards.filter(card => card.underlyingPreview.status === 'censored').length,
      underlyingStops: underlyingSl,
      stopTriggers: underlyingSlByTrigger,
      ambiguous: underlyingCandidates.filter(card => card.underlyingPreview.status === 'ambiguous').length,
      tgt1: underlyingTgt1,
      baselineTgt1SameCards: premiumBaselineTgt1,
      winnersLost: underlyingCandidates.filter(card => card.variants.baseline.status === 'tgt1' && card.underlyingPreview.status !== 'tgt1').length,
      open: underlyingCandidates.filter(card => card.underlyingPreview.status === 'open').length,
      baselinePremiumStopsSameCards: premiumBaselineSl,
      underlyingStopRate: underlyingCandidates.length ? underlyingSl / underlyingCandidates.length : null,
      baselineStopRateSameCards: underlyingCandidates.length ? premiumBaselineSl / underlyingCandidates.length : null,
      slRateReduction: underlyingCandidates.length ? (premiumBaselineSl - underlyingSl) / underlyingCandidates.length : null,
      reducesSlRate: underlyingCandidates.length > 0 && underlyingSl < premiumBaselineSl,
    },
    cards: graded,
  };
}

function printReport(report, write = console.log) {
  write(`SL width · ${report.dateRange.from}–${report.dateRange.to} · ${report.totalCards} cards`);
  write('variant           bucket             n  SL%   TGT1%  close  lost   netR   dip₹');
  for (const variant of report.variants) {
    for (const [bucket, row] of Object.entries(variant.byBucket)) {
      if (!row.cards) continue;
      const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
      write(`${variant.label.padEnd(17)} ${bucket.padEnd(18)} ${String(row.sampled).padStart(3)} ${pct(row.slRate).padStart(5)} ${pct(row.tgt1Rate).padStart(7)} ${String(row.closeExits).padStart(6)} ${String(row.winnersLost).padStart(5)} ${String(row.netR == null ? '—' : row.netR.toFixed(2)).padStart(7)} ${String(row.preTargetDipMean == null ? '—' : row.preTargetDipMean.toFixed(2)).padStart(7)}`);
    }
    const row = variant.overall;
    const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
    write(`${variant.label.padEnd(17)} ${'ALL'.padEnd(18)} ${String(row.sampled).padStart(3)} ${pct(row.slRate).padStart(5)} ${pct(row.tgt1Rate).padStart(7)} ${String(row.closeExits).padStart(6)} ${String(row.winnersLost).padStart(5)} ${String(row.netR == null ? '—' : row.netR.toFixed(2)).padStart(7)} ${String(row.preTargetDipMean == null ? '—' : row.preTargetDipMean.toFixed(2)).padStart(7)}`);
  }
  const underlying = report.underlyingPreview;
  const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
  write(`Underlying preview: ${underlying.underlyingStops}/${underlying.comparableCards} SL (${pct(underlying.underlyingStopRate)}), premium baseline same cards ${underlying.baselinePremiumStopsSameCards} (${pct(underlying.baselineStopRateSameCards)}), ΔSL ${pct(underlying.slRateReduction)}; TGT1 ${underlying.tgt1} vs baseline ${underlying.baselineTgt1SameCards}, winners lost ${underlying.winnersLost}; slSpot ${underlying.cardsWithSlSpot}, futures ${underlying.cardsWithFutures}, partial windows ${underlying.partialFutureWindows}, triggers ${JSON.stringify(underlying.stopTriggers)}.`);
}

export async function runSlWidthBacktest({ from, to, observationsPath = OBSERVATIONS, reportPath = REPORT, write = console.log } = {}) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Provide a valid ordered <fromDate> <toDate>.');
  const store = JSON.parse(await fs.promises.readFile(observationsPath, 'utf8'));
  const cards = (Array.isArray(store?.cards) ? store.cards : []).filter(card => card?.date >= from && card?.date <= to);
  const timelines = await extractContractTimelines(cards, expectedTradingDates, {
    readRawIndex,
    readRawMinute,
    readArchiveMinutes,
  });
  const underlyingTimelines = await extractUnderlyingTimelines(cards, expectedTradingDates, {
    readRawFutures,
    readArchiveFutures,
  });
  const report = buildSlWidthReport(cards, timelines, { from, to, underlyingTimelines });
  await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
  printReport(report, write);
  write(`\nreport → ${path.relative(ROOT, reportPath)}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [from, to, ...extra] = process.argv.slice(2);
  if (!from || !to || extra.length) {
    console.error('usage: node scripts/slWidthBacktest.mjs <fromDate> <toDate>');
    process.exitCode = 1;
  } else {
    runSlWidthBacktest({ from, to }).catch(error => {
      console.error(`SL-width backtest failed: ${String(error?.message || error)}`);
      process.exitCode = 1;
    });
  }
}
