/**
 * Level-pair backtest — for every entry, which comes first: the target or the
 * stop? Marginal percentiles cannot answer that; only walking the path can.
 *
 *   node --max-old-space-size=6144 scripts/backtestLevels.mjs TITAN [more…] | --all
 *
 * For each symbol it replays the owner's 1-minute EQUITY history and, for a grid
 * of (target %, stop %) pairs, counts win / loss / still-open at the end of the
 * hold, plus the average mark-to-market R of the open ones. Everything is
 * conditioned on the regime known at entry (up / down / range).
 *
 * Rules that keep it honest:
 *   - a bar that touches BOTH levels counts as a LOSS (we cannot know the order)
 *   - the entry price is the close of the entry minute, never the bar's high
 *   - multi-day holds walk the following sessions' minutes in order
 *   - "open" is not a win: it is marked at the hold's last price
 */
import { openSync, readSync, closeSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regimeOf } from '../server/moveRegime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_ROOT = process.env.HISTORY_CSV_ROOT || '/Users/himanshuvaghela/Downloads/NSE DERIVATIVES';
const OUT_DIR = path.join(ROOT, 'server', 'data', 'level-grid');
const TARGETS = [0.3, 0.5, 0.8, 1.2, 2, 3];
const STOPS = [0.5, 1, 1.5, 2, 3, 5, 8];
const ENTRY_TIMES = ['09:30', '11:00', '13:00', '14:30'];
const HOLDS = [1, 2, 3, 5];
const REGIMES = ['up', 'down', 'range'];
const RECENT_FROM = process.env.LEVEL_GRID_RECENT ?? '2020.01.01';

const args = process.argv.slice(2);
const symbols = args.includes('--all')
  ? readdirSync(HISTORY_ROOT).filter(name => name.endsWith('-EQ')).map(name => name.replace(/-EQ$/, ''))
  : args.filter(a => !a.startsWith('--')).map(a => a.toUpperCase());
if (!symbols.length) { console.error('usage: node scripts/backtestLevels.mjs <SYMBOL…> | --all'); process.exit(1); }

function loadDays(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let pos = 0;
  let carry = '';
  const days = new Map();
  const take = line => {
    if (!line.trim()) return;
    const f = line.split(',');
    if (f.length !== 7) return;
    const [date, time, , high, low, close] = f;
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return;
    const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (minute < 555 || minute > 930) return;
    const h = Number(high); const l = Number(low); const c = Number(close);
    if (!(c > 0 && h > 0 && l > 0)) return;
    let day = days.get(date);
    if (!day) { day = { t: [], h: [], l: [], c: [] }; days.set(date, day); }
    day.t.push(time); day.h.push(h); day.l.push(l); day.c.push(c);
  };
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    pos += n;
    const text = carry + buf.toString('utf8', 0, n);
    const lines = text.split('\n');
    carry = lines.pop();
    for (const line of lines) take(line);
  }
  take(carry);
  closeSync(fd);
  return days;
}

/**
 * First-touch indices for every target and stop level in one forward walk.
 * `dir` +1 means the trade wants price up (a CE), −1 wants it down (a PE).
 */
function firstTouches(highs, lows, closes, from, to, base, dir) {
  const upTargets = TARGETS.map(t => base * (1 + (dir > 0 ? t : -t) / 100));
  const downStops = STOPS.map(s => base * (1 - (dir > 0 ? s : -s) / 100));
  const targetHit = new Array(TARGETS.length).fill(-1);
  const stopHit = new Array(STOPS.length).fill(-1);
  let remainingT = TARGETS.length;
  let remainingS = STOPS.length;
  for (let i = from; i < to && (remainingT || remainingS); i++) {
    const hi = highs[i];
    const lo = lows[i];
    for (let t = 0; t < TARGETS.length; t++) {
      if (targetHit[t] >= 0) continue;
      const level = upTargets[t];
      if (dir > 0 ? hi >= level : lo <= level) { targetHit[t] = i; remainingT--; }
    }
    for (let s = 0; s < STOPS.length; s++) {
      if (stopHit[s] >= 0) continue;
      const level = downStops[s];
      if (dir > 0 ? lo <= level : hi >= level) { stopHit[s] = i; remainingS--; }
    }
  }
  return { targetHit, stopHit };
}

mkdirSync(OUT_DIR, { recursive: true });
let done = 0;
for (const symbol of symbols) {
  const file = path.join(HISTORY_ROOT, `${symbol}-EQ`, `${symbol}-EQ1.csv`);
  if (!existsSync(file)) { console.log(`${symbol}: no CSV`); continue; }
  const started = Date.now();
  const days = loadDays(file);
  const dates = [...days.keys()].sort();
  if (dates.length < 60) { console.log(`${symbol}: too few days`); continue; }
  const dayClose = dates.map(d => { const c = days.get(d).c; return c[c.length - 1]; });
  const regimes = dates.map((_, i) => regimeOf(dayClose, i));

  // cells keyed by `${scope}|${regime}|${dir}` → pair stats
  const cells = new Map();
  const cellFor = (scope, regime, dir) => {
    const key = `${scope}|${regime}|${dir}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { scope, regime, dir, samples: 0, pairs: TARGETS.map(() => STOPS.map(() => ({ win: 0, loss: 0, open: 0, openR: 0 }))) };
      cells.set(key, cell);
    }
    return cell;
  };

  const record = (cell, touches, endPrice, base, dir) => {
    cell.samples++;
    for (let t = 0; t < TARGETS.length; t++) {
      for (let s = 0; s < STOPS.length; s++) {
        const pair = cell.pairs[t][s];
        const ti = touches.targetHit[t];
        const si = touches.stopHit[s];
        if (ti >= 0 && (si < 0 || ti < si)) pair.win++;
        else if (si >= 0) pair.loss++; // both in one bar counts as a loss
        else {
          pair.open++;
          const risk = base * STOPS[s] / 100;
          pair.openR += risk > 0 ? ((endPrice - base) * dir) / risk : 0;
        }
      }
    }
  };

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    if (date < RECENT_FROM) continue;
    const regime = regimes[d];
    const day = days.get(date);
    // Intraday: entry minute → the rest of that session.
    for (const entry of ENTRY_TIMES) {
      const i = day.t.indexOf(entry);
      if (i < 0 || i >= day.c.length - 10) continue;
      const base = day.c[i];
      for (const dir of [1, -1]) {
        const touches = firstTouches(day.h, day.l, day.c, i + 1, day.c.length, base, dir);
        record(cellFor(`intraday:${entry}`, regime, dir), touches, day.c[day.c.length - 1], base, dir);
      }
    }
    // Multi-day: entry at the close → the next `hold` sessions, minute by minute.
    for (const hold of HOLDS) {
      if (d + hold >= dates.length) continue;
      const base = dayClose[d];
      if (!(base > 0)) continue;
      const highs = []; const lows = []; const closes = [];
      for (let k = d + 1; k <= d + hold; k++) {
        const nd = days.get(dates[k]);
        for (let j = 0; j < nd.c.length; j++) { highs.push(nd.h[j]); lows.push(nd.l[j]); closes.push(nd.c[j]); }
      }
      if (!closes.length) continue;
      for (const dir of [1, -1]) {
        const touches = firstTouches(highs, lows, closes, 0, closes.length, base, dir);
        record(cellFor(`hold:${hold}`, regime, dir), touches, closes[closes.length - 1], base, dir);
      }
    }
  }

  const out = [...cells.values()].map(cell => ({
    scope: cell.scope,
    regime: cell.regime,
    side: cell.dir > 0 ? 'CE' : 'PE',
    samples: cell.samples,
    pairs: cell.pairs.flatMap((row, t) => row.map((pair, s) => {
      const n = cell.samples || 1;
      const avgOpenR = pair.open ? pair.openR / pair.open : 0;
      return {
        targetPct: TARGETS[t],
        stopPct: STOPS[s],
        win: pair.win,
        loss: pair.loss,
        open: pair.open,
        winRate: pair.win / n,
        lossRate: pair.loss / n,
        openRate: pair.open / n,
        avgOpenR,
        // A win pays target/stop R, not 1R — the reward is the target distance.
        expectancyR: (pair.win * (TARGETS[t] / STOPS[s]) - pair.loss + pair.openR) / n,
        expectancyPct: ((pair.win * TARGETS[t] - pair.loss * STOPS[s]) / n) + (pair.openR * STOPS[s]) / n,
      };
    })),
  }));

  writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify({
    symbol, instrument: 'EQ', generatedAt: new Date().toISOString(),
    from: RECENT_FROM, days: dates.length, targets: TARGETS, stops: STOPS, cells: out,
  }));
  done++;
  console.log(`${symbol}: ${cells.size} cells · ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`\n${done}/${symbols.length} symbols → server/data/level-grid/`);