import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inFireWindow, marketMovers } from './alerts.mjs';

/**
 * TypeSafe (Jev) triage — the model supplies judgments, code decides.
 *
 * Every TRIAGE_MINUTES the live build path hands the fresh market file here.
 * Code builds the same digest the board shows (top movers, chain OI, the
 * day-floor build-up flags), then asks Jev two things per flagged symbol: is
 * it worth watching as a live setup, and which way does it lean. The decision
 * stays in code (routing by probability):
 *
 *   watch ≥ 0.7  → an auto buildup-watch rule (fires through the alert engine,
 *                  deterministic evaluation, 10-minute cooldown)
 *   0.3 – 0.7    → digest-only: logged, no rule
 *   ≤ 0.3        → ignored
 *
 * Auto rules land in `<DATA_DIR>/alerts.auto.json`; the engine merges them
 * with the hand-written alerts.json on every evaluation. If TypeSafe is
 * unconfigured, errors, or the window has passed, nothing here throws into
 * the build path — the engine simply runs on the static rules alone.
 */

const MINUTE = 60_000;
const TRIAGE_MINUTES = Math.max(5, Math.min(30, Number(process.env.TYPESAFE_TRIAGE_MIN) || 10));
const WATCH_YES = 0.7;
const WATCH_NO = 0.3;
const MAX_WATCHES = 8;
const API = 'https://api.typesafe.ai/v1/systemone';

export function typesafeConfigured() {
  return typeof process.env.TYPESAFE_API_KEY === 'string' && process.env.TYPESAFE_API_KEY.length > 0;
}

/** One System One request. Errors surface as errors — never read as answers. */
export async function askTypeSafe(state, questions) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: 'jev-latest', questions }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`typesafe: HTTP ${res.status}`);
  return (await res.json()).answers;
}

const oiText = value => `${value >= 0 ? '+' : ''}${(value / 1_000_000).toFixed(2)}M`;

/** The digest a person would read off the board — code computes every number. */
export function digestText(market, movers) {
  const rows = movers ?? marketMovers(market);
  const top = (list, face) => list.slice(0, 10).map((m, i) =>
    `${i + 1}. ${m.symbol} ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}% (spot ${m.spot}) chain OI ${oiText(m.oiAdded)}${m.buildup ? ` — ${m.buildup}` : ''}`).join('\n');
  const buildups = rows.filter(r => r.buildup);
  return [
    `Live F&O dashboard digest, ${new Date(market?.t ?? Date.now()).toISOString()} (${market?.date ?? 'session'}).`,
    `Top risers (day):\n${top([...rows].sort((a, b) => b.changePct - a.changePct))}`,
    `Top fallers (day):\n${top([...rows].sort((a, b) => a.changePct - b.changePct))}`,
    `Symbols flagged build-up by the day's floors:\n${buildups.map(m => `${m.symbol} ${m.buildup} — price ${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%, chain OI ${m.oiPct >= 0 ? '+' : ''}${m.oiPct.toFixed(1)}%`).join('\n') || '(none yet)'}`,
  ].join('\n\n');
}

/** Question wording lives here, and only here, so thresholds and criteria stay auditable. */
export function triageQuestions(rows) {
  const questions = {
    worth_watching: {
      type: 'noul',
      instructions: 'At least one symbol in this digest is worth watching right now as a live trade setup.',
      criteria: { true: 'Some symbol shows a fresh directional move with OI joining it — the kind of thing a trader would put an alert on.', false: 'The digest is mixed noise: moves without OI confirmation, or everything already extended.' },
    },
  };
  for (const m of rows) {
    questions[`watch_${m.symbol}`] = {
      type: 'noul',
      instructions: { question: `Is \`${m.symbol}\` worth watching right now as a live trade setup?`, inspect: `\`${m.symbol}\` in the digest` },
      criteria: { true: 'The symbol shows a fresh move with OI confirming it — an alert-worthy setup in progress.', false: 'The move looks like one-off noise or is too small to act on.' },
    };
    questions[`bias_${m.symbol}`] = {
      type: 'choice',
      instructions: { question: `What is the live bias on \`${m.symbol}\`?` },
      criteria: { bullish: 'Price up with OI added — longs building.', bearish: 'Price down with OI added — shorts building.', unclear: 'Move and OI do not agree, or the signal is too weak to call.' },
    };
  }
  return questions;
}

/** The decision table — pure, so it is testable without any network. */
export function triageDecisions(rows, answers, { yes = WATCH_YES, no = WATCH_NO, cap = MAX_WATCHES } = {}) {
  const screen = answers?.worth_watching?.noul;
  if (!(screen >= no)) return { screen: screen ?? null, watches: [], digestOnly: [] };
  const watches = [], digestOnly = [];
  for (const m of rows) {
    const watch = answers?.[`watch_${m.symbol}`]?.noul;
    const bias = answers?.[`bias_${m.symbol}`]?.choice ?? 'unclear';
    const entry = { symbol: m.symbol, watch, bias, buildup: m.buildup };
    if (watch >= yes) watches.push(entry);
    else if (watch > no) digestOnly.push(entry);
  }
  watches.sort((a, b) => b.watch - a.watch);
  return { screen, watches: watches.slice(0, cap), digestOnly };
}

const autoRule = entry => ({
  id: `ts-watch-${entry.symbol}`,
  type: 'buildup',
  symbol: entry.symbol,
  auto: true,
  label: `${entry.symbol} (Jev watch, ${entry.bias})`,
});

let lastTriageAt = 0;
let triageInFlight = false;

/**
 * Throttled triage pass. Returns the drafts written (or the reason it skipped).
 * Never throws on TypeSafe failures — a failed pass keeps yesterday's auto
 * rules and the engine carries on with static rules alone.
 */
export async function runTriage(market, { autoPath, now = Date.now(), log = () => {}, ask = askTypeSafe, configured = typesafeConfigured } = {}) {
  if (!configured()) return { skipped: 'not configured' };
  if (!inFireWindow(now)) return { skipped: 'outside fire window' };
  if (triageInFlight) return { skipped: 'pass already running' };
  if (now - lastTriageAt < TRIAGE_MINUTES * MINUTE) return { skipped: 'throttled' };
  const movers = marketMovers(market).filter(m => m.buildup);
  if (!movers.length) return { skipped: 'no build-ups flagged' };
  triageInFlight = true;
  lastTriageAt = now;
  try {
    const answers = await ask({ digest: digestText(market, marketMovers(market)) }, triageQuestions(movers));
    const decisions = triageDecisions(movers, answers);
    // A hand-written buildup rule already covering the symbol wins — no double alerts.
    let staticSymbols = [];
    try {
      staticSymbols = JSON.parse(readFileSync(join(dirname(autoPath), 'alerts.json'), 'utf8'))
        ?.rules?.filter(r => r?.type === 'buildup').map(r => r.symbol) ?? [];
    } catch { /* no static rules file — nothing to dedupe against */ }
    const watches = decisions.watches.filter(w => !staticSymbols.includes(w.symbol));
    const payload = JSON.stringify({ rules: watches.map(autoRule) }, null, 2);
    const tmp = `${autoPath}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, autoPath);
    for (const d of decisions.digestOnly) log(`triage digest-only: ${d.symbol} watch=${d.watch.toFixed(2)} (${d.bias})`);
    return { screen: decisions.screen, written: watches.length, watches };
  } catch (error) {
    log(`triage failed (auto rules unchanged): ${String(error?.message || error)}`);
    return { skipped: 'failed', error: String(error?.message || error) };
  } finally {
    triageInFlight = false;
  }
}
