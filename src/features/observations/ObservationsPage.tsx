import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { applyTheme } from '@/lib/applyTheme';
import { clockOf } from '../market-flow/marketFlowModel';
import { uniqueObservationCards } from './observationModel';
import './observations.css';

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const OBSERVATIONS_URL = `${API}/api/observations`;
const SPOTS_STREAM_URL = `${API}/api/stream/spots`;
const MARKET_URL = `${API}/api/market`;
const POLL_MS = 30_000;
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const priceText = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : '—';

interface ObservationCard {
  id: string;
  at: number;
  date: string;
  symbol: string;
  spot?: number | null;
  spotChangePct?: number | null;
  bias: 'bullish' | 'bearish';
  side: 'CE' | 'PE';
  strike: number;
  expiry: string | null;
  entry: number;
  sl: number;
  tgt1: number;
  tgt2: number;
  tsl: string;
  support: { strike: number; oi: number; changePct: number | null } | null;
  resistance: { strike: number; oi: number; changePct: number | null } | null;
  quality: number;
  strikePickProbability: number;
  oiChangePct: number | null;
  disclaimer: string;
}

interface SpotReading { sp: number; pc: number; changePct: number | null }

type SpotMap = Map<string, SpotReading>;

/** Live spots + contract ticks over server-sent events — the feed's tick
 *  readings, pushed ~3s. trackedSymbols adds futures ticks, trackedOptions
 *  (SYM|strike|SIDE|expiry) adds live option premiums. A one-shot /api/market
 *  fetch primes the map, and a slow poll takes over only while the stream is
 *  down. */
function useMarketSnapshot(trackedSymbols: string[], trackedOptions: string[]) {
  const [spots, setSpots] = useState<SpotMap>(new Map());
  const [futuresTicks, setFuturesTicks] = useState<Record<string, { ltp: number }>>({});
  const [optionTicks, setOptionTicks] = useState<Record<string, { ltp: number }>>({});
  const [asOf, setAsOf] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const symbolsKey = trackedSymbols.join(','), optionsKey = trackedOptions.join(',');
  useEffect(() => {
    let alive = true;
    const fromBody = (body: { t?: number; spots?: Record<string, { ltp?: number; prevClose?: number }>; futures?: Record<string, { ltp?: number }>; optionTicks?: Record<string, { ltp?: number }> }) => {
      const map: SpotMap = new Map();
      for (const [symbol, reading] of Object.entries(body.spots ?? {})) {
        const ltp = reading?.ltp;
        const prevClose = reading?.prevClose;
        if (typeof ltp === 'number' && Number.isFinite(ltp) && typeof prevClose === 'number' && Number.isFinite(prevClose) && prevClose > 0) {
          map.set(symbol, { sp: ltp, pc: prevClose, changePct: ((ltp - prevClose) / prevClose) * 100 });
        }
      }
      if (map.size) { setSpots(map); setAsOf(typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : null); setFailed(false); }
      if (body.futures) setFuturesTicks(body.futures);
      if (body.optionTicks) setOptionTicks(body.optionTicks);
    };
    // Prime once from the built snapshot (covers symbols the stream may not have yet).
    fetch(MARKET_URL, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
      if (!alive) return;
      const map: SpotMap = new Map();
      for (const series of body?.series ?? []) {
        if (Number.isFinite(series?.sp) && Number.isFinite(series?.pc) && series.pc > 0) {
          map.set(series.s, { sp: series.sp, pc: series.pc, changePct: ((series.sp - series.pc) / series.pc) * 100 });
        }
      }
      setSpots(map);
      setAsOf(Number.isFinite(body?.t) ? body.t : null);
    }).catch(() => { /* the stream or the next poll will fill in */ });
    const query = `?symbols=${encodeURIComponent(symbolsKey)}&options=${encodeURIComponent(optionsKey)}`;
    const source = new EventSource(SPOTS_STREAM_URL + query);
    source.onmessage = event => {
      if (!alive) return;
      try { fromBody(JSON.parse(event.data)); } catch { /* malformed frame — ignore */ }
    };
    source.onerror = () => { if (alive) setFailed(true); };
    const timer = setInterval(() => {
      if (!alive) return;
      fetch(MARKET_URL, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        const map: SpotMap = new Map();
        for (const series of body?.series ?? []) {
          if (Number.isFinite(series?.sp) && Number.isFinite(series?.pc) && series.pc > 0) {
            map.set(series.s, { sp: series.sp, pc: series.pc, changePct: ((series.sp - series.pc) / series.pc) * 100 });
          }
        }
        setSpots(map);
        setAsOf(Number.isFinite(body?.t) ? body.t : null);
      }).catch(() => { if (alive) setFailed(true); });
    }, 60_000);
    return () => { alive = false; source.close(); clearInterval(timer); };
  }, [symbolsKey, optionsKey]);
  return { spots, futuresTicks, optionTicks, asOf, failed };
}

interface FuturesSeries { at: number; close: number }

/** The card symbol's session futures line — the same persisted series the board charts. */
function useFutures(symbol: string | undefined) {
  const [closes, setCloses] = useState<FuturesSeries[] | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    setCloses(null);
    const read = () => {
      fetch(`${API}/api/futures/${encodeURIComponent(symbol)}`, { cache: 'no-store' }).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        const months = Array.isArray(body?.months) ? body.months : [];
        const candles = months[0]?.candles ?? [];
        setCloses(candles.filter((c: { at?: unknown; close?: unknown }) => Number.isFinite(c?.at) && Number.isFinite(c?.close)).map((c: { at: number; close: number }) => ({ at: c.at, close: c.close })));
      }).catch(() => { if (alive) setCloses(null); });
    };
    read();
    const timer = setInterval(read, 120_000);
    return () => { alive = false; clearInterval(timer); };
  }, [symbol]);
  return closes;
}

function Sparkline({ closes }: { closes: FuturesSeries[] | null }) {
  if (!closes || closes.length < 2) return <div className="obs-spark obs-spark--empty">futures line warming up…</div>;
  const width = 280, height = 54, pad = 4;
  const values = closes.map(c => c.close);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const points = closes.map((c, i) => `${pad + (i / (closes.length - 1)) * (width - pad * 2)},${height - pad - ((c.close - min) / span) * (height - pad * 2)}`);
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className={`obs-spark ${up ? 'is-up' : 'is-down'}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${closes.length} futures closes, session line`}>
      <polyline className="obs-spark__area" points={` ${pad},${height - pad} ${points.join(' ')} ${width - pad},${height - pad}`} />
      <polyline className="obs-spark__line" points={points.join(' ')} />
    </svg>
  );
}

function CardLive({ card, spots, futuresTick, optionTick, closes }: {
  card: ObservationCard;
  spots: SpotMap;
  futuresTick?: { ltp: number };
  optionTick?: { ltp: number };
  closes: FuturesSeries[] | null;
}) {
  const liveSpot = spots.get(card.symbol);
  const spot = liveSpot ?? (card.spot != null ? { sp: card.spot, changePct: card.spotChangePct ?? null } : null);
  const opt = optionTick?.ltp;
  return (
    <div className="obs-card__live">
      <Sparkline closes={closes} />
      <div className="obs-card__quote">
        <span className="obs-card__quote-symbol">{card.symbol}</span>
        {spot
          ? <><span className={`obs-card__quote-ltp ${spot.changePct != null && spot.changePct >= 0 ? 'is-up' : 'is-down'}`}>{priceText(spot.sp)}</span><span className={`obs-card__quote-chg ${spot.changePct != null && spot.changePct >= 0 ? 'is-up' : 'is-down'}`}>{spot.changePct != null ? `${spot.changePct >= 0 ? '+' : ''}${spot.changePct.toFixed(2)}%` : '—'}</span></>
          : <span className="obs-card__quote-chg">spot warming up…</span>}
        {futuresTick && <span className="obs-card__quote-sub" title="live futures price (~3s ticks)">fut {priceText(futuresTick.ltp)}</span>}
        <span className="obs-card__quote-sub" title="live option premium (~3s ticks) vs entry">
          {card.side} {opt != null ? <b className={opt >= card.entry ? 'is-up' : 'is-down'}>₹{priceText(opt)}</b> : `~₹${priceText(card.entry)}`} · entry ₹{priceText(card.entry)}
        </span>
      </div>
    </div>
  );
}

function Card({ card, spots, futuresTicks, optionTicks }: {
  card: ObservationCard;
  spots: SpotMap;
  futuresTicks: Record<string, { ltp: number }>;
  optionTicks: Record<string, { ltp: number }>;
}) {
  const up = card.bias === 'bullish';
  const closes = useFutures(card.symbol);
  const optionKey = `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`;
  return (
    <article className={`obs-card ${up ? 'obs-card--bull' : 'obs-card--bear'}`}>
      <header className="obs-card__head">
        <h3 className="obs-card__symbol">{card.symbol}</h3>
        <span className={`obs-card__contract ${up ? 'is-up' : 'is-down'}`}>{card.strike} {card.side}</span>
        <span className={`obs-card__bias ${up ? 'is-up' : 'is-down'}`}>{up ? 'bullish' : 'bearish'} · quality {(card.quality * 100).toFixed(0)}%</span>
        <time className="obs-card__time">{clockOf(card.at)}</time>
      </header>
      <CardLive card={card} spots={spots} futuresTick={futuresTicks[card.symbol]} optionTick={optionTicks[optionKey]} closes={closes} />
      <dl className="obs-card__levels">
        <div><dt>Entry</dt><dd>~{priceText(card.entry)}</dd></div>
        <div className="is-down"><dt>SL −45%</dt><dd>{priceText(card.sl)}</dd></div>
        <div className="is-up"><dt>TGT1 +55%</dt><dd>{priceText(card.tgt1)}</dd></div>
        <div className="is-up"><dt>TGT2 +90%</dt><dd>{priceText(card.tgt2)}</dd></div>
      </dl>
      <p className="obs-card__walls">
        {card.support && <span>support {card.support.strike} PE ({(card.support.oi / 1_000_000).toFixed(1)}M{card.support.changePct != null ? ` ${card.support.changePct >= 0 ? '+' : ''}${card.support.changePct.toFixed(2)}%` : ''})</span>}
        {card.resistance && <span>resistance {card.resistance.strike} CE ({(card.resistance.oi / 1_000_000).toFixed(1)}M{card.resistance.changePct != null ? ` ${card.resistance.changePct >= 0 ? '+' : ''}${card.resistance.changePct.toFixed(2)}%` : ''})</span>}
        <span className="obs-card__tsl">{card.tsl}</span>
      </p>
      <footer className="obs-card__foot">{card.disclaimer}</footer>
    </article>
  );
}

function IndexStrip({ spots, futuresTicks, asOf, failed }: { spots: SpotMap; futuresTicks: Record<string, { ltp: number }>; asOf: number | null; failed: boolean }) {
  return (
    <div className="obs-indices" role="status" aria-live="polite">
      {INDEX_SYMBOLS.map(symbol => {
        const spot = spots.get(symbol);
        const fut = futuresTicks[symbol]?.ltp;
        const up = (spot?.changePct ?? 0) >= 0;
        return (
          <span key={symbol} className="obs-index">
            <span className="obs-index__name">{symbol === 'NIFTY' ? 'Nifty' : symbol === 'BANKNIFTY' ? 'BankNifty' : 'Sensex'}</span>
            {spot
              ? <><span className={`obs-index__ltp ${up ? 'is-up' : 'is-down'}`}>{priceText(spot.sp)}</span><span className={`obs-index__chg ${up ? 'is-up' : 'is-down'}`}>{up ? '▲' : '▼'} {Math.abs(spot.changePct ?? 0).toFixed(2)}%</span></>
              : <span className="obs-index__ltp">—</span>}
            {fut != null && <span className="obs-index__fut" title="live futures price — ticks every ~3s (Dhan's feed does not stream index spot)">fut {priceText(fut)}</span>}
          </span>
        );
      })}
      <span className="obs-indices__asof">{failed ? 'spot feed retrying…' : asOf ? `live · ${clockOf(asOf)}` : ''}</span>
    </div>
  );
}

export function ObservationsPage({ tabs }: { tabs?: ReactNode }) {
  const [cards, setCards] = useState<ObservationCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Always track the three indices' futures; add every card symbol + its exact option contract.
  const trackedSymbols = useMemo(
    () => [...new Set([...INDEX_SYMBOLS, ...(cards ?? []).map(card => card.symbol)])],
    [cards],
  );
  const trackedOptions = useMemo(
    () => (cards ?? []).filter(card => card.expiry).map(card => `${card.symbol}|${card.strike}|${card.side}|${card.expiry}`),
    [cards],
  );
  const { spots, futuresTicks, optionTicks, asOf, failed: spotFailed } = useMarketSnapshot(trackedSymbols, trackedOptions);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetch(OBSERVATIONS_URL).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        setCards(uniqueObservationCards(Array.isArray(body?.cards) ? body.cards : []));
        setFailed(false);
      }).catch(() => { if (alive) setFailed(true); });
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const bar = (
    <>
      {tabs}
      <span className="ui-flow-spacer" aria-hidden="true" />
      <ThemeToggle onChange={theme => applyTheme(theme)} />
    </>
  );
  return (
    <div className="observations">
      <PageBar current="Observations" crumbs={false} className="ui-flow-pagebar">{bar}</PageBar>
      <IndexStrip spots={spots} futuresTicks={futuresTicks} asOf={asOf} failed={spotFailed} />
      <div className="observations__status mf-status" role="status" aria-live="polite">
        {failed
          ? <span className="is-down">Observations could not be loaded — retrying every 30s.</span>
          : cards == null
            ? <span>Reading observations…</span>
            : <span><b>{cards.length}</b> card{cards.length === 1 ? '' : 's'} today · advisor re-reads watched symbols every 10 minutes · buy-side only</span>}
      </div>
      <div className="observations__list">
        {cards != null && cards.length === 0 && (
          <section className="observations__empty" role="status">
            <div><h2>No observations yet</h2><p>When the advisor promotes a build-up to a watch (quality ≥ 70%), its strike observation card appears here — with entry, stop and targets computed from the captured chain.</p></div>
          </section>
        )}
        {cards?.map(card => <Card key={card.id} card={card} spots={spots} futuresTicks={futuresTicks} optionTicks={optionTicks} />)}
      </div>
    </div>
  );
}
