#!/usr/bin/env node
/** Read-only cross-tab of saved observation outcomes by build-time regime. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegimeWinsReport, printRegimeWinsReport } from '../server/regimeWins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OBSERVATIONS = path.join(ROOT, 'server', 'data', 'observations.json');
const REPORT = path.join(ROOT, 'server', 'data', 'regime-wins-report.json');

export function runRegimeWins({ observationsPath = OBSERVATIONS, reportPath = REPORT, now = Date.now(), write = console.log } = {}) {
  const store = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
  const cards = Array.isArray(store?.cards) ? store.cards : [];
  const report = { ...buildRegimeWinsReport(cards), generatedAt: new Date(now).toISOString() };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printRegimeWinsReport(report, write);
  write(`\nreport → ${path.relative(ROOT, reportPath)}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runRegimeWins(); }
  catch (error) {
    console.error(`regime-wins report failed: ${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}
