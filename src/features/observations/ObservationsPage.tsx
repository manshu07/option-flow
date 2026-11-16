import { useEffect, useState, type ReactNode } from 'react';
import { PageBar } from '@/components/chrome/PageBar';
import { ThemeToggle } from '@/components/chrome/ThemeToggle';
import { clockOf } from '../market-flow/marketFlowModel';
import './observations.css';

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const POLL_MS = 30_000;

interface ObservationCard {
  id: string;
  at: number;
  date: string;
  symbol: string;
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

const oiText = (value: number) => `${(value / 1_000_000).toFixed(1)}M`;

function Card({ card }: { card: ObservationCard }) {
  const up = card.bias === 'bullish';
  return (
    <article className={`obs-card ${up ? 'obs-card--bull' : 'obs-card--bear'}`}>
      <header className="obs-card__head">
        <h3 className="obs-card__symbol">{card.symbol}</h3>
        <span className={`obs-card__contract ${up ? 'is-up' : 'is-down'}`}>{card.strike} {card.side}</span>
        <span className={`obs-card__bias ${up ? 'is-up' : 'is-down'}`}>{up ? 'bullish' : 'bearish'} · quality {(card.quality * 100).toFixed(0)}%</span>
        <time className="obs-card__time">{clockOf(card.at)}</time>
      </header>
      <dl className="obs-card__levels">
        <div><dt>Entry</dt><dd>~{card.entry}</dd></div>
        <div className="is-down"><dt>SL −45%</dt><dd>{card.sl}</dd></div>
        <div className="is-up"><dt>TGT1 +55%</dt><dd>{card.tgt1}</dd></div>
        <div className="is-up"><dt>TGT2 +90%</dt><dd>{card.tgt2}</dd></div>
      </dl>
      <p className="obs-card__walls">
        {card.support && <span>support {card.support.strike} PE ({oiText(card.support.oi)}{card.support.changePct != null ? ` ${card.support.changePct >= 0 ? '+' : ''}${card.support.changePct}%` : ''})</span>}
        {card.resistance && <span>resistance {card.resistance.strike} CE ({oiText(card.resistance.oi)}{card.resistance.changePct != null ? ` ${card.resistance.changePct >= 0 ? '+' : ''}${card.resistance.changePct}%` : ''})</span>}
        <span className="obs-card__tsl">{card.tsl}</span>
      </p>
      <footer className="obs-card__foot">{card.disclaimer}</footer>
    </article>
  );
}

export function ObservationsPage({ tabs }: { tabs?: ReactNode }) {
  const [cards, setCards] = useState<ObservationCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetch(`${API}/observations.json`).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (!alive) return;
        setCards(Array.isArray(body?.cards) ? body.cards : []);
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
      <ThemeToggle />
    </>
  );
  return (
    <div className="observations" ref={undefined}>
      <PageBar current="Observations" crumbs={false} className="ui-flow-pagebar">{bar}</PageBar>
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
        {cards?.map(card => <Card key={card.id} card={card} />)}
      </div>
    </div>
  );
}
