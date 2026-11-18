// Offline only: a full archive can exceed the API process's memory budget.
// node --max-old-space-size=8192 scripts/backfillJournalArchive.mjs <date> <archive.gz|raw-day-dir> <obsPath> [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { resolveCard, trackCardFollowThrough, withJournalStoreLock } from '../server/journal.mjs';
import { isMarketSessionTime, marketCloseMinuteFor, marketParts } from '../src/lib/marketSession.ts';
import { readFutures } from '../server/replayStorage.mjs';

export function backfillJournalFollowThrough({ date, inputPath, obsPath, dryRun = false, now = Date.now() }) {
  const parsedDate = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date) {
    throw new Error('Expected a valid YYYY-MM-DD session date.');
  }
  const current = marketParts(now);
  if (!dryRun && (isMarketSessionTime(now) || date > current.dateKey
    || (date === current.dateKey && current.minuteOfDay <= marketCloseMinuteFor(now)))) {
    throw new Error('Offline writes require a closed session outside market hours; use --dry-run otherwise.');
  }
  const isRaw = fs.statSync(inputPath).isDirectory();
  let snapshots;
  let archivedFutures = {};
  if (isRaw) {
    const index = JSON.parse(fs.readFileSync(path.join(inputPath, 'index.json'), 'utf8'));
    if (!Array.isArray(index)) throw new Error('Raw minute index must be an array.');
    snapshots = [];
    for (const entry of index) {
      const hhmm = String(entry?.[0] ?? '').padStart(4, '0');
      if (!/^\d{4}$/.test(hhmm) || Number(hhmm.slice(0, 2)) > 23 || Number(hhmm.slice(2)) > 59) throw new Error('Invalid raw minute index entry.');
      try { snapshots.push(JSON.parse(fs.readFileSync(path.join(inputPath, `${hhmm}.json`), 'utf8'))); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  } else {
    const payload = JSON.parse(gunzipSync(fs.readFileSync(inputPath)).toString('utf8'));
    if (payload.date !== date || !payload.minutes || typeof payload.minutes !== 'object' || Array.isArray(payload.minutes)) {
      throw new Error('Archive does not contain the requested session.');
    }
    snapshots = Object.values(payload.minutes);
    if (payload.futures && typeof payload.futures === 'object' && !Array.isArray(payload.futures)) archivedFutures = payload.futures;
  }
  snapshots = snapshots.filter(snapshot => snapshot && snapshot.date === date && Number.isFinite(snapshot.t));
  snapshots.sort((a, b) => a.t - b.t);
  if (!snapshots.length) throw new Error('Source has no captures for the requested session.');

  function update() {
    const original = fs.readFileSync(obsPath, 'utf8');
    const store = JSON.parse(original);
    if (!Array.isArray(store?.cards)) throw new Error('Observations store has no cards array.');
    const changes = [];
    const cards = store.cards.map(card => {
      if (card?.date !== date) return card;
      let futuresCandles = [];
      try {
        const future = isRaw ? readFutures(path.dirname(path.resolve(inputPath)), date, card.symbol) : archivedFutures[card.symbol];
        if (future?.symbol === card.symbol && future?.session === date && Array.isArray(future.months?.[0]?.candles)) {
          futuresCandles = future.months[0].candles;
        }
      } catch { /* Old or missing futures files leave the additive range unavailable. */ }
      const followThrough = trackCardFollowThrough(card, snapshots, { source: isRaw ? 'raw' : 'archive', futuresCandles });
      if (!followThrough || (card.outcome?.followThrough?.version === 1 && card.outcome.followThrough.sampleCount > followThrough.sampleCount)) return card;
      if (!followThrough.futures && card.outcome?.followThrough?.from === card.at && card.outcome.followThrough.futures) {
        followThrough.futures = card.outcome.followThrough.futures;
      }
      const legacy = card.outcome ?? resolveCard(card, snapshots);
      // Never invent a settled journal outcome when no readable contract exists.
      if (!legacy) return card;
      const outcome = { ...legacy, followThrough };
      if (JSON.stringify(outcome) === JSON.stringify(card.outcome)) return card;
      changes.push({ symbol: card.symbol, strike: card.strike, side: card.side, status: legacy.status, followThrough });
      return { ...card, outcome };
    });

    let backupPath = null;
    if (changes.length && !dryRun) {
      if (fs.readFileSync(obsPath, 'utf8') !== original) throw new Error('Observations changed during backfill; no update written.');
      backupPath = `${obsPath}.follow-through-backup-${Date.now()}`;
      fs.writeFileSync(backupPath, original, { flag: 'wx' });
      const temporary = `${obsPath}.${process.pid}.follow-through.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ ...store, cards }, null, 2), { flag: 'wx' });
        if (fs.readFileSync(obsPath, 'utf8') !== original) throw new Error('Observations changed during backfill; no update written.');
        fs.renameSync(temporary, obsPath);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    return { date, source: isRaw ? 'raw' : 'archive', snapshots: snapshots.length, updated: changes.length, dryRun, backupPath, changes };
  }
  return dryRun ? update() : withJournalStoreLock(obsPath, update);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [date, inputPath, obsPath, ...flags] = process.argv.slice(2);
  if (!date || !inputPath || !obsPath || flags.some(flag => flag !== '--dry-run')) {
    console.error('usage: backfillJournalArchive.mjs <YYYY-MM-DD> <archive.gz|raw-day-dir> <observations.json> [--dry-run]');
    process.exitCode = 1;
  } else {
    try {
      const result = backfillJournalFollowThrough({ date, inputPath, obsPath, dryRun: flags.includes('--dry-run') });
      console.log(`${result.source} ${date}: ${result.snapshots} snapshots; ${result.updated} card(s) ${result.dryRun ? 'would be enriched' : 'enriched'}`);
      for (const card of result.changes) {
        const report = card.followThrough;
        const touches = Object.entries(report.touches).filter(([, touch]) => touch).map(([level, touch]) => `${level} seen ${new Date(touch.at).toISOString()}`).join(', ') || 'no touch observed';
        console.log(`${card.symbol} ${card.strike}${card.side}: journal=${card.status}; ${touches}; ${report.sequence}; ${report.sampleCount}/${report.expectedMinutes} captured minutes`);
      }
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
    } catch (error) {
      console.error(String(error?.message || error));
      process.exitCode = 1;
    }
  }
}
