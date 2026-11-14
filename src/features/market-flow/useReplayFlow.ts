import { useEffect, useMemo, useRef, useState } from 'react';
import { getThemeDirectory, type Underlying } from '@/lib/underlyings';
import { type FuturesSeries } from '../options-scanner/futuresModel';
import { clockOf, nearSeries, buildMarketFlow, type FlowSettings, type MarketFlow } from './marketFlowModel';
import { fetchMarketMinute, fetchReplayDays, fetchReplayFutures, fetchReplayManifest, sourceForDay, type ReplayDay, type ReplayManifest, type ReplaySource } from './feed';
import { advanceReplay, boardReplayMinutes, clipReplayMinutes, isSelectableReplayDay, loadPlaybackSpeed, playbackIntervalMs, rememberMarketMinute, REPLAY_CACHE_LIMIT, savePlaybackSpeed, sliceFuturesSeries, type ReplayModeState, type ReplaySpeed, type ReplayWindow, type ReplayWindowSpec } from './replayModel';
import type { ContractMarket } from '../options-scanner/contractScanModel';

interface ReplayFlowOptions {
  requested: boolean;
  date: string;
}

const initialMode: ReplayModeState = { mode: 'live', playing: false, cursorIndex: 0 };
const initialWindow: ReplayWindowSpec = { window: 'full' };

function symbolsFor(market: ContractMarket, universe: readonly Underlying[], settings: FlowSettings, now: number): string[] {
  return universe.filter(item => {
    if (settings.scope === 'stocks' && item.kind !== 'stock') return false;
    if (settings.scope === 'indices' && item.kind !== 'index') return false;
    return Boolean(nearSeries(market, item.symbol, now));
  }).map(item => item.symbol);
}

function manifestMinutes(manifest: ReplayManifest): Array<[string, number]> {
  return [...(manifest.minutes ?? manifest.minutesIndex ?? [])].sort((a, b) => a[1] - b[1]);
}

function futureAvailable(manifest: ReplayManifest, symbol: string): boolean {
  const coverage = manifest.futures[symbol];
  return coverage ? coverage.available !== false : Boolean(manifest.futuresSymbols?.includes(symbol));
}

/** Recorded/archive reads for opt-in replay. The live hook remains untouched. */
export function useReplayFlow(universe: readonly Underlying[], settings: FlowSettings, options: ReplayFlowOptions) {
  const [days, setDays] = useState<ReplayDay[]>([]);
  const [selection, setSelection] = useState<{ date: string; source: ReplaySource }>({ date: options.date, source: 'live' });
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ReplayManifest | null>(null);
  const [windowSpec, setWindowSpec] = useState<ReplayWindowSpec>(initialWindow);
  const [speed, setSpeedState] = useState<ReplaySpeed>(loadPlaybackSpeed);
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
  const [catalogRetryVersion, setCatalogRetryVersion] = useState(0);
  const [frame, setFrame] = useState<{ key: string; market: ContractMarket; flow: MarketFlow } | null>(null);
  const marketCacheRef = useRef(marketCache);
  marketCacheRef.current = marketCache;
  const run = useRef(0);
  const futuresRetryController = useRef<AbortController | null>(null);
  const userSelectedDay = useRef(false);

  const sectorLabels = useMemo(() => {
    const labels = getThemeDirectory()?.sectors ?? {};
    return Object.fromEntries(Object.entries(labels).map(([id, entry]) => [id, entry.label])) as Record<string, string>;
  }, []);

  // The list is provider-scoped by the server. Keep non-replayable entries for disabled UI feedback.
  useEffect(() => {
    if (!options.requested) {
      setDays([]);
      setCatalogReady(false); setCatalogError(null);
      setSelection({ date: options.date, source: 'live' });
      userSelectedDay.current = false;
      return undefined;
    }
    const controller = new AbortController();
    setCatalogReady(false); setCatalogError(null); setLoading(true);
    void (async () => {
      let listed: ReplayDay[];
      try {
        listed = typeof fetchReplayDays === 'function' ? await fetchReplayDays(controller.signal) : [];
      } catch (reason) {
        if (!controller.signal.aborted) {
          setCatalogError(`Replay catalog unavailable${reason instanceof Error && reason.message ? `: ${reason.message}` : '.'}`);
          setLoading(false);
        }
        return;
      }
      if (controller.signal.aborted) return;
      const sorted = [...listed].sort((a, b) => b.date.localeCompare(a.date));
      setDays(sorted);
      if (!userSelectedDay.current) {
        const preferred = sorted.find(day => day.date === options.date);
        const preferredSource = sourceForDay(preferred);
        if (preferred && isSelectableReplayDay(preferred) && preferredSource) {
          setSelection({ date: preferred.date, source: preferredSource });
          setCatalogReady(true);
        } else {
          setCatalogError(preferred
            ? (preferredSource ? `Replay date ${options.date} has no captured minutes.` : `Replay date ${options.date} has an invalid source.`)
            : `No replay catalog entry for ${options.date}.`);
          setLoading(false);
        }
      } else {
        setCatalogReady(true);
      }
    })();
    return () => controller.abort();
  }, [catalogRetryVersion, options.date, options.requested]);

  // Date/source changes always start at the first captured minute and clear only the committed frame.
  useEffect(() => {
    const token = ++run.current;
    if (!options.requested) {
      futuresRetryController.current?.abort();
      futuresRetryController.current = null;
      setManifest(null); setMode(initialMode); setMarketCache(new Map()); setFutures(new Map()); setSymbols([]); setFrame(null);
      setLoading(false); setError(null); setFuturesError(null); setSessionReady(false); setFailedFutures([]); setRetryingFutures(false);
      return undefined;
    }
    if (!catalogReady) return undefined;
    const controller = new AbortController();
    futuresRetryController.current?.abort();
    futuresRetryController.current = null;
    setLoading(true); setError(null); setFuturesError(null); setFutures(new Map()); setSymbols([]); setFrame(null);
    setSessionReady(false); setFailedFutures([]); setRetryingFutures(false); setManifest(null); setMode({ mode: 'replay', playing: false, cursorIndex: 0 }); setMarketCache(new Map());

    void (async () => {
      const next = await fetchReplayManifest(selection.date, controller.signal, selection.source).catch(() => null);
      if (controller.signal.aborted || token !== run.current) return;
      if (!next) {
        setError(`No captured replay minutes for ${selection.date}.`); setLoading(false); return;
      }
      const minutes = boardReplayMinutes(next.date, manifestMinutes(next));
      if (!minutes.length) {
        setError(`No captured board minutes for ${selection.date}.`); setLoading(false); return;
      }
      const session: ReplayManifest = { ...next, source: selection.source, minutes, start: minutes[0][1], end: minutes.at(-1)![1] };
      const finalMinute = minutes.at(-1)!;
      const latest = await fetchMarketMinute(session.date, finalMinute[0], controller.signal, selection.source).catch(() => null);
      if (controller.signal.aborted || token !== run.current) return;
      if (!latest) {
        setManifest(session); setError(`Replay minute ${finalMinute[0]} is unavailable. Captured range ${clockOf(session.start!)}–${clockOf(session.end!)}.`); setLoading(false); return;
      }
      const requestedSymbols = symbolsFor(latest, universe, settings, finalMinute[1]);
      const available = requestedSymbols.filter(symbol => futureAvailable(session, symbol));
      const reads = await Promise.all(available.map(async symbol => [symbol, await fetchReplayFutures(symbol, session.date, finalMinute[0], controller.signal, selection.source).catch(() => null)] as const));
      if (controller.signal.aborted || token !== run.current) return;
      const readMap = new Map<string, FuturesSeries | null>(requestedSymbols.map(symbol => [symbol, null]));
      for (const [symbol, series] of reads) readMap.set(symbol, series);
      const missing = requestedSymbols.filter(symbol => !available.includes(symbol) || !readMap.get(symbol));
      const failed = available.filter(symbol => !readMap.get(symbol));
      setManifest(session); setMarketCache(rememberMarketMinute(new Map(), finalMinute[0], latest, REPLAY_CACHE_LIMIT)); setFutures(readMap); setSymbols(requestedSymbols);
      setFuturesError(missing.length ? `Replay futures unavailable for ${missing.length} symbol${missing.length === 1 ? '' : 's'} (${clockOf(session.start!)}–${clockOf(session.end!)}).` : null);
      setFailedFutures(failed); setSessionReady(true); setMode({ mode: 'replay', playing: false, cursorIndex: 0 }); setLoading(false);
    })();
    return () => { controller.abort(); futuresRetryController.current?.abort(); };
  }, [catalogReady, options.requested, selection, sessionRetryVersion, settings, universe]);

  const activeManifest = useMemo(() => {
    if (!manifest) return null;
    const minutes = clipReplayMinutes(manifest.date, manifest.minutes ?? [], windowSpec);
    return { ...manifest, minutes, start: minutes[0]?.[1] ?? null, end: minutes.at(-1)?.[1] ?? null };
  }, [manifest, windowSpec]);
  const emptyWindow = Boolean(activeManifest && activeManifest.minutes.length === 0);
  const replayError = catalogError ?? error ?? (emptyWindow ? 'No captured minutes in this window. Choose Full day or another window.' : null);
  const cursor = activeManifest?.minutes[mode.cursorIndex] ?? null;
  const cursorMs = cursor?.[1] ?? null;
  const marketAtCursor = cursor ? marketCache.get(cursor[0]) ?? null : null;
  const cursorKey = cursor ? `${activeManifest?.date}:${cursor[0]}` : null;

  // Read the current minute into the bounded LRU.
  useEffect(() => {
    if (mode.mode !== 'replay' || !sessionReady || !activeManifest || !cursor) return undefined;
    const controller = new AbortController();
    const current = marketCacheRef.current.get(cursor[0]);
    if (!current) {
      setError(null);
      void fetchMarketMinute(activeManifest.date, cursor[0], controller.signal, activeManifest.source).then(next => {
        if (controller.signal.aborted || !next) {
          if (!controller.signal.aborted && cursorKey === `${activeManifest.date}:${cursor[0]}`) {
            setError(`Replay minute ${cursor[0]} is unavailable. Captured range ${clockOf(activeManifest.start!)}–${clockOf(activeManifest.end!)}.`);
            setMode(currentMode => ({ ...currentMode, playing: false }));
          }
          return;
        }
        setMarketCache(cache => rememberMarketMinute(cache, cursor[0], next, REPLAY_CACHE_LIMIT));
      }).catch(() => {
        if (!controller.signal.aborted && cursorKey === `${activeManifest.date}:${cursor[0]}`) {
          setError(`Replay minute ${cursor[0]} is unavailable. Captured range ${clockOf(activeManifest.start!)}–${clockOf(activeManifest.end!)}.`);
          setMode(currentMode => ({ ...currentMode, playing: false }));
        }
      });
    } else setError(null);
    return () => controller.abort();
  }, [activeManifest, cursor, cursorKey, mode.mode, sessionReady, retryVersion]);

  // Keep the next five captured snapshots warm while playback is inside a window.
  useEffect(() => {
    if (mode.mode !== 'replay' || !sessionReady || !activeManifest || !cursor) return undefined;
    const controller = new AbortController();
    const index = activeManifest.minutes.findIndex(([minute]) => minute === cursor[0]);
    const nextMinutes = activeManifest.minutes.slice(index + 1, index + 6).filter(([minute]) => !marketCacheRef.current.has(minute));
    void Promise.all(nextMinutes.map(async ([minute]) => [minute, await fetchMarketMinute(activeManifest.date, minute, controller.signal, activeManifest.source).catch(() => null)] as const)).then(reads => {
      if (controller.signal.aborted) return;
      setMarketCache(cache => reads.reduce((next, [minute, value]) => value ? rememberMarketMinute(next, minute, value, REPLAY_CACHE_LIMIT) : next, cache));
    });
    return () => controller.abort();
  }, [activeManifest, cursor, mode.mode, sessionReady]);

  const sliced = useMemo(() => cursorMs == null ? new Map<string, FuturesSeries | null>() : new Map([...futures].map(([symbol, series]) => [symbol, series ? sliceFuturesSeries(series, cursorMs) : null])), [cursorMs, futures]);
  const candidateFlow = useMemo(() => marketAtCursor && cursorMs != null ? buildMarketFlow(marketAtCursor, sliced, universe, sectorLabels, settings, { now: cursorMs }) : null, [cursorMs, marketAtCursor, sectorLabels, settings, sliced, universe]);

  // A cursor can move before its market file arrives. Commit the board only with a complete matching frame.
  useEffect(() => {
    if (candidateFlow && marketAtCursor && cursorKey) setFrame({ key: cursorKey, market: marketAtCursor, flow: candidateFlow });
  }, [candidateFlow, cursorKey, marketAtCursor]);
  const frameReady = Boolean(frame && frame.key === cursorKey);

  useEffect(() => {
    if (mode.mode !== 'replay' || !sessionReady || !mode.playing || !activeManifest || !frameReady) return undefined;
    const timer = window.setInterval(() => setMode(current => advanceReplay(current, activeManifest.minutes.length - 1)), playbackIntervalMs(speed));
    return () => window.clearInterval(timer);
  }, [activeManifest, frameReady, mode.mode, mode.playing, sessionReady, speed]);

  const goLive = () => { setMode(initialMode); setManifest(null); setFrame(null); };
  const retry = () => {
    if (!catalogReady) { setCatalogRetryVersion(version => version + 1); return; }
    if (!sessionReady) { setSessionRetryVersion(version => version + 1); return; }
    if (error && cursor) { setError(null); setMode(current => ({ ...current, mode: 'replay', playing: false })); setRetryVersion(version => version + 1); return; }
    if (failedFutures.length && manifest && !retryingFutures) {
      const controller = new AbortController(); const token = run.current; futuresRetryController.current?.abort(); futuresRetryController.current = controller; setRetryingFutures(true);
      void Promise.all(failedFutures.map(async symbol => [symbol, await fetchReplayFutures(symbol, manifest.date, manifest.minutes?.at(-1)?.[0] ?? '', controller.signal, manifest.source).catch(() => null)] as const)).then(results => {
        if (controller.signal.aborted || token !== run.current) return;
        const remaining = results.filter(([, series]) => !series).map(([symbol]) => symbol);
        setFutures(current => { const next = new Map(current); for (const [symbol, series] of results) if (series) next.set(symbol, series); return next; });
        setFailedFutures(remaining); setFuturesError(remaining.length ? `Replay futures unavailable for ${remaining.length} symbol${remaining.length === 1 ? '' : 's'}.` : null); setRetryingFutures(false); futuresRetryController.current = null;
      });
    }
  };
  const seek = (index: number) => {
    if (!activeManifest) return;
    setError(null); setMode(current => ({ ...current, mode: 'replay', playing: false, cursorIndex: Math.max(0, Math.min(index, activeManifest.minutes.length - 1)) }));
  };
  const selectDay = (date: string) => {
    const day = days.find(item => item.date === date);
    const source = sourceForDay(day);
    if (!day || !isSelectableReplayDay(day) || !source) return;
    userSelectedDay.current = true; setCatalogError(null); setCatalogReady(true); setFrame(null); setSelection({ date: day.date, source }); setWindowSpec(initialWindow);
  };
  const setWindow = (window: ReplayWindow, start?: string, end?: string) => {
    setWindowSpec({ window, start, end });
    setMode(current => ({ ...current, playing: false, cursorIndex: 0 }));
  };
  const setSpeed = (next: ReplaySpeed) => { setSpeedState(next); savePlaybackSpeed(next); };

  return {
    active: mode.mode === 'replay', mode, manifest: activeManifest, days, selectedDate: selection.date, selectedSource: selection.source,
    flow: frame?.flow ?? null, market: frame?.market ?? null, loading: loading || (mode.mode === 'replay' && !frameReady && !replayError && !emptyWindow), error: replayError, notice: futuresError,
    retryingFutures, retryableFutures: failedFutures.length > 0, cursorMs, cursorLabel: cursorMs != null ? clockOf(cursorMs) : null,
    symbols, futuresRead: futures.size, futuresTotal: symbols.length, provider: manifest ? { id: manifest.provider.id, label: manifest.provider.label, alwaysLive: false } : null,
    window: windowSpec.window, customStart: windowSpec.start ?? '', customEnd: windowSpec.end ?? '', speed,
    togglePlay: () => {
      if (error) { retry(); return; }
      setMode(current => current.cursorIndex >= (activeManifest?.minutes.length ?? 1) - 1 && !current.playing ? { ...current, mode: 'replay', playing: true, cursorIndex: 0 } : { ...current, mode: 'replay', playing: !current.playing });
    },
    seek, selectDay, setWindow, setSpeed, goLive, retry,
  };
}
