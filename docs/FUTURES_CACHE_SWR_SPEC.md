# Futures cache — stale-while-revalidate across tab unmounts — Spec

**Owner:** Kilo Code (implementer) · Architect/verifier: Qwen · Date: 2026-11-16
**Size:** ~3 SP · **Branch:** `main` (single commit: `perf(futures-cache)`)
**File touched:** `src/features/market-flow/feed.ts` ONLY (+ its test file).

## Why

Order Flow / Option Board / Observations are conditionally mounted in
`App.tsx`. Leaving Order Flow unmounts `useFuturesFeed`, which loses its
series state — returning re-fetches all ~215 futures from zero
("Updating · futures 76 of 215", featured cards gated at ≥90% settled go
blank). After a server restart the re-fetch is even slower (in-memory caches
cleared, Dhan REST paced). The fix is stale-while-revalidate: keep the last
good readings in a module-level cache, paint them instantly on remount, and
refresh in the background exactly as today.

This mirrors patterns already in the repo: the strike-flow client cache
(20s TTL LRU in `src/features/strike-flow/feed.ts`) and the replay
stale-while-revalidate work (S7/S8).

## The change (feed.ts only)

1. Module scope, above `useFuturesFeed`:
   ```ts
   /** Last good futures per `session|symbol` — survives tab unmounts so a
    *  remount paints instantly while the background refresh runs. */
   const futuresCache = new Map<string, FuturesSeries | null>();
   const cacheKey = (session: string, symbol: string) => `${session}|${symbol}`;
   ```
   Bounded by the universe (~215 entries per session); no LRU needed. Don't
   cache `null` (failures) — only successful reads.
2. In `useFuturesFeed`:
   - On mount (the `tick === 0` pass), before fetching: seed `series` from the
     cache for every symbol that has an entry, and start `done` at the number
     of cached entries (so a warm remount shows `215 of 215`, never `76 of
     215`). Symbols still missing from the cache fetch as today.
   - The background worker still fetches EVERY symbol in the list (cache is a
     paint optimisation, not a skip): successful reads go through
     `futuresCache.set(cacheKey(session, symbol), result)` as well as
     `setSeries`. Failures keep today's semantics (leave the previous reading
     in place, track in `failed`).
   - The worker must not double-count: `done` only counts symbols that were
     NOT served from the cache. Simplest correct rule: a symbol is "already
     done" if the cache had an entry for it at pass start.
   - Keep the refresh intervals (60s/120s) and the `moving()` gate untouched.
3. Nothing else changes: server endpoints, FlowBoard rendering, the featured
   ≥90% gate (it now passes immediately on a warm remount), Observations page.

## Explicitly NOT here (parked)

- Keeping pages mounted with CSS visibility (heavier, more risk).
- Serving persisted futures files from the client (server already handles the
  closed-market disk fast path).
- Caching option-chain reads (Option Board already has its own 20s cache).

## Tests

Feed logic is hook-shaped; extract the two pure cache helpers and test those,
plus one hook-level case:

- `cacheGet`/`cachePut` (or the equivalent inline logic made testable): put
  two symbols for session A, read for session B → only A's entries returned.
- Hook remount case (jsdom + `renderHook` or a tiny probe component): after a
  first mount with resolved fetches, a second mount reports
  `read === total` immediately and `series` already populated from the cache
  before the refresh pass lands.
- Empty cache first mount behaves exactly as today (0 → counts up).

## Gates

- `npx tsc --noEmit` clean; `npm test` green; no server file modified.

## Handoff prompt (paste into Kilo)

> Read `docs/FUTURES_CACHE_SWR_SPEC.md` and implement it exactly: a
> module-level last-good futures cache in `src/features/market-flow/feed.ts`
> so remounting Order Flow paints instantly from cache while the background
> refresh re-reads all symbols (progress starts at the cached count, failures
> never cached, sessions isolated). Add the listed tests. Only feed.ts and its
> test file may change. Pause when tests pass for verification.
