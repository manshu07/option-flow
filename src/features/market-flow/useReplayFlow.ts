import { useEffect, useMemo, useRef, useState } from 'react';
import { getThemeDirectory, type Underlying } from '@/lib/underlyings';
import { type FuturesSeries } from '../options-scanner/futuresModel';
import { clockOf, nearSeries, buildMarketFlow, type FlowSettings, type MarketFlow } from './marketFlowModel';
import { fetchMarketMinute, fetchReplayFutures, fetchReplayManifest, type ReplayManifest } from './feed';
import { advanceReplay, boardReplayMinutes, rememberMarketMinute, sliceFuturesSeries, type ReplayModeState } from './replayModel';
import type { ContractMarket } from '../options-scanner/contractScanModel';

interface ReplayFlowOptions {
  requested: boolean;
  date: string;
}

const initialMode: ReplayModeState = { mode: 'live', playing: false, cursorIndex: 0 };

function symbolsFor(market: ContractMarket, universe: readonly Underlying[], settings: FlowSettings, now: number): string[] {
  return universe.filter(item => {
    if (settings.scope === 'stocks' && item.kind !== 'stock') return false;
    if (settings.scope === 'indices' && item.kind !== 'index') return false;
    return Boolean(nearSeries(market, item.symbol, now));
  }).map(item => item.symbol);
}

/** Recorded market/futures reads for the opt-in replay mode. Live reads stay in useMarketFlow. */
export function useReplayFlow(universe: readonly Underlying[], settings: FlowSettings, options: ReplayFlowOptions) {
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);
  const [mode, setMode] = useState<ReplayModeState>(initialMode);
  const [marketCache, setMarketCache] = useState<Map<string, ContractMarket>>(new Map());
  const [futures, setFutures] = useState<ReadonlyMap<string, FuturesSeries | null>>(new Map());
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [futuresError, setFuturesError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [failedFutures, setFailedFutures] = useState<string[]>([]);
  const [retryingFutures, setRetryingFutures] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [sessionRetryVersion, setSessionRetryVersion] = useState(0);
  const run = useRef(0);
  const futuresRetryController = useRef<AbortController | null>(null);

  const sectorLabels = useMemo(() => {
    const labels = getThemeDirectory()?.sectors ?? {};
    return Object.fromEntries(Object.entries(labels).map(([id, entry]) => [id, entry.label])) as Record<string, string>;
  }, []);

  useEffect(() => {
    const token = ++run.current;
    if (!options.requested) {
      futuresRetryController.current?.abort();
      futuresRetryController.current = null;
      setManifest(null); setMode(initialMode); setMarketCache(new Map()); setFutures(new Map()); setSymbols([]);
      setLoading(false); setError(null); setFuturesError(null); setSessionReady(false); setFailedFutures([]); setRetryingFutures(false);
      return undefined;
    }
    const controller = new AbortController();
    futuresRetryController.current?.abort();
    futuresRetryController.current = null;
    setLoading(true); setError(null); setFuturesError(null); setFutures(new Map()); setSymbols([]);
    setSessionReady(false); setFailedFutures([]); setRetryingFutures(false);
    setManifest(null); setMode({ mode: 'replay', playing: false, cursorIndex: 0 }); setMarketCache(new Map());

    void (async () => {
      const next = await fetchReplayManifest(options.date, controller.signal).catch(() => null);
      if (controller.signal.aborted || token !== run.current) return;
      if (!next || !next.minutes.length) {
        setError(`No captured replay minutes for ${options.date}.`);
        setLoading(false);
        return;
      }
      const minutes = boardReplayMinutes(next.date, [...next.minutes].sort((a, b) => a[1] - b[1]));
      if (!minutes.length) {
        setError(`No captured board minutes for ${options.date}.`);
        setLoading(false);
        return;
      }
      const session = { ...next, minutes, start: minutes[0][1], end: minutes.at(-1)![1] };
      const finalMinute = minutes.at(-1)!;
      const latest = await fetchMarketMinute(session.date, finalMinute[0], controller.signal).catch(() => null);
      if (controller.signal.aborted || token !== run.current) return;
      if (!latest) {
        setManifest(session);
        setError(`Replay minute ${finalMinute[0]} is unavailable. Captured range ${clockOf(session.start!)}–${clockOf(session.end!)}.`);
        setLoading(false);
        return;
      }
      const requestedSymbols = symbolsFor(latest, universe, settings, finalMinute[1]);
      const available = requestedSymbols.filter(symbol => session.futures[symbol]?.available);
      const reads = await Promise.all(available.map(async symbol => [symbol, await fetchReplayFutures(symbol, session.date, finalMinute[0], controller.signal).catch(() => null)] as const));
      if (controller.signal.aborted || token !== run.current) return;
      const readMap = new Map<string, FuturesSeries | null>(requestedSymbols.map(symbol => [symbol, null]));
      for (const [symbol, series] of reads) readMap.set(symbol, series);
      const missing = requestedSymbols.filter(symbol => !session.futures[symbol]?.available || !readMap.get(symbol));
      const failed = available.filter(symbol => !readMap.get(symbol));
      setManifest(session);
      setMarketCache(new Map([[finalMinute[0], latest]]));
      setFutures(readMap);
      setSymbols(requestedSymbols);
      setFuturesError(missing.length ? `Replay futures unavailable for ${missing.length} symbol${missing.length === 1 ? '' : 's'} (${clockOf(session.start)}–${clockOf(session.end)}).` : null);
      setFailedFutures(failed);
      setSessionReady(true);
      setMode({ mode: 'replay', playing: false, cursorIndex: 0 });
      setLoading(false);
    })();
    return () => {
      controller.abort();
      futuresRetryController.current?.abort();
    };
  }, [options.date, options.requested, sessionRetryVersion, settings, universe]);

  const cursor = manifest?.minutes[mode.cursorIndex] ?? null;
  const cursorMs = cursor?.[1] ?? null;
  const market = cursor ? marketCache.get(cursor[0]) ?? null : null;

  useEffect(() => {
    if (mode.mode !== 'replay' || !sessionReady || !manifest || !cursor) return undefined;
    const cached = marketCache.get(cursor[0]);
    if (cached) { setError(null); return undefined; }
    const controller = new AbortController();
    setError(null);
    void fetchMarketMinute(manifest.date, cursor[0], controller.signal).then(next => {
      if (controller.signal.aborted) return;
      if (!next) {
        setError(`Replay minute ${cursor[0]} is unavailable. Captured range ${clockOf(manifest.start!)}–${clockOf(manifest.end!)}.`);
        setMode(current => ({ ...current, playing: false }));
        return;
      }
      setMarketCache(current => rememberMarketMinute(current, cursor[0], next));
    }).catch(() => {
      if (!controller.signal.aborted) {
        setError(`Replay minute ${cursor[0]} is unavailable. Captured range ${clockOf(manifest.start!)}–${clockOf(manifest.end!)}.`);
        setMode(current => ({ ...current, playing: false }));
      }
    });
    return () => controller.abort();
  }, [cursor, manifest, marketCache, mode.mode, retryVersion, sessionReady]);

  useEffect(() => {
    if (mode.mode !== 'replay' || !sessionReady || !mode.playing || !manifest || !market) return undefined;
    const timer = window.setInterval(() => setMode(current => advanceReplay(current, manifest.minutes.length - 1)), 700);
    return () => window.clearInterval(timer);
  }, [manifest, market, mode.mode, mode.playing, sessionReady]);

  const sliced = useMemo(() => {
    if (cursorMs == null) return new Map<string, FuturesSeries | null>();
    return new Map([...futures].map(([symbol, series]) => [symbol, series ? sliceFuturesSeries(series, cursorMs) : null]));
  }, [cursorMs, futures]);

  const flow: MarketFlow | null = useMemo(() => (
    market && cursorMs != null
      ? buildMarketFlow(market, sliced, universe, sectorLabels, settings, { now: cursorMs })
      : null
  ), [cursorMs, market, sectorLabels, settings, sliced, universe]);

  const goLive = () => { setMode(initialMode); setManifest(null); };
  const retry = () => {
    if (!sessionReady) { setSessionRetryVersion(version => version + 1); return; }
    if (error && cursor) {
      setError(null);
      setMode(current => ({ ...current, mode: 'replay', playing: false }));
      setRetryVersion(version => version + 1);
      return;
    }
    if (failedFutures.length && manifest && !retryingFutures) {
      const controller = new AbortController();
      const token = run.current;
      futuresRetryController.current?.abort();
      futuresRetryController.current = controller;
      setRetryingFutures(true);
      void (async () => {
        const lastMinute = manifest.minutes.at(-1)?.[0];
        if (!lastMinute) {
          setRetryingFutures(false);
          futuresRetryController.current = null;
          return;
        }
        const results = await Promise.all(failedFutures.map(async symbol => [
          symbol,
          await fetchReplayFutures(symbol, manifest.date, lastMinute, controller.signal).catch(() => null),
        ] as const));
        if (controller.signal.aborted || token !== run.current) return;
        const remaining = results.filter(([, series]) => !series).map(([symbol]) => symbol);
        setFutures(current => {
          const next = new Map(current);
          for (const [symbol, series] of results) if (series) next.set(symbol, series);
          return next;
        });
        setFailedFutures(remaining);
        const unavailable = symbols.filter(symbol => !manifest.futures[symbol]?.available).length;
        const missing = remaining.length + unavailable;
        const start = manifest.start ?? manifest.minutes[0]?.[1] ?? 0;
        const end = manifest.end ?? manifest.minutes.at(-1)?.[1] ?? start;
        setFuturesError(missing ? `Replay futures unavailable for ${missing} symbol${missing === 1 ? '' : 's'} (${clockOf(start)}–${clockOf(end)}).` : null);
        setRetryingFutures(false);
        futuresRetryController.current = null;
      })();
      return;
    }
    if (!manifest) { setSessionRetryVersion(version => version + 1); return; }
    if (!cursor) return;
  };
  const seek = (index: number) => {
    if (!manifest) return;
    setError(null);
    setMode(current => ({ ...current, mode: 'replay', playing: false, cursorIndex: Math.max(0, Math.min(index, manifest.minutes.length - 1)) }));
  };

  return {
    active: mode.mode === 'replay', mode, manifest, flow, market, loading: loading || (mode.mode === 'replay' && !market && !error), error, notice: futuresError,
    retryingFutures, retryableFutures: failedFutures.length > 0,
    cursorMs, cursorLabel: cursorMs != null ? clockOf(cursorMs) : null, symbols, futuresRead: futures.size, futuresTotal: symbols.length,
    provider: manifest ? { id: manifest.provider.id, label: manifest.provider.label, alwaysLive: false } : null,
    togglePlay: () => {
      if (error) { retry(); return; }
      setMode(current => current.cursorIndex >= (manifest?.minutes.length ?? 1) - 1 && !current.playing
        ? { ...current, mode: 'replay', playing: true, cursorIndex: 0 }
        : { ...current, mode: 'replay', playing: !current.playing });
    },
    seek, goLive, retry,
  };
}
