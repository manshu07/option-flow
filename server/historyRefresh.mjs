/**
 * Daily history refresh — keeps the futures store current without anyone
 * running scripts by hand.
 *
 * NSE publishes the F&O bhavcopy in the evening, so the refresh runs once a
 * day after 19:30 IST: fetch any missing recent sessions, fold in our own
 * capture, then rebuild the futures move statistics.
 *
 * The due check is pure and tested; the runner only spawns the existing
 * offline scripts, so nothing heavy ever runs inside the API's own heap.
 */
const IST_OFFSET = 19_800_000;
const REFRESH_MINUTE = 19 * 60 + 30;

export function istParts(at) {
  const d = new Date(at + IST_OFFSET);
  return {
    date: d.toISOString().slice(0, 10),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** Once per calendar day, at or after 19:30 IST. */
export function historyRefreshDue(at, lastRunDate = null) {
  if (!Number.isFinite(at)) return false;
  const { date, minuteOfDay } = istParts(at);
  if (minuteOfDay < REFRESH_MINUTE) return false;
  return lastRunDate !== date;
}

/** The window to ask for: a week back, so a missed evening self-heals. */
export function refreshWindow(at, lookbackDays = 7) {
  const { date } = istParts(at);
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  return { from, to: date };
}

const STEPS = [
  { name: 'bhavcopy', script: 'scripts/fetchBhavcopy.mjs', args: window => [window.from, window.to] },
  { name: 'capture', script: 'scripts/accumulateFutures.mjs', args: () => [] },
  { name: 'fut-stats', script: 'scripts/ingestFutStats.mjs', args: () => [] },
];

/**
 * Run the three offline steps in order. Each is a child process with its own
 * heap; a failure is logged and the rest still run, so one bad evening does
 * not stop the capture fold or the stats rebuild.
 */
export async function runHistoryRefresh({ root, at = Date.now(), log = () => {}, run }) {
  const window = refreshWindow(at);
  const results = [];
  for (const step of STEPS) {
    try {
      const code = await run(step.script, step.args(window));
      results.push({ step: step.name, code });
      log(`history refresh ${step.name}: exit ${code}`);
    } catch (error) {
      results.push({ step: step.name, error: String(error?.message || error) });
      log(`history refresh ${step.name} failed: ${String(error?.message || error)}`);
    }
  }
  return { window, results };
}