// backfillSparseSymbols - DEPRECATED: superseded by scripts/retrySparseBackfill.mjs, which
// is REST-ONLY (server/dhanRest.mjs) and safe to run while the live server holds the WS feed.
//
// WHY THIS SHIM EXISTS: the original version called createDhanProvider().init(), which opened
// the full 5-connection feed and stole the live server's Dhan slots (2026-11-24 connection-limit
// incident: live server fell to 0/5 for ~30 min during market hours). Offline scripts must
// NEVER open the WS feed - enforced by server/scriptsHygiene.test.ts.
//
// Use instead:  node scripts/retrySparseBackfill.mjs <YYYY-MM-DD> SYM1,SYM2,...
console.error('backfillSparseSymbols is retired - use: node scripts/retrySparseBackfill.mjs <date> SYM1,SYM2,...');
process.exit(1);
