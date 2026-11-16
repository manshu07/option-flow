import { useEffect, useState } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { MarketFlowPage } from '@/features/market-flow/MarketFlowPage';
import { StrikeFlowPage } from '@/features/strike-flow/StrikeFlowPage';
import { ObservationsPage } from '@/features/observations/ObservationsPage';
import { loadUnderlyings, type Underlying } from '@/lib/underlyings';

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const OBSERVATIONS_URL = `${API}/api/observations`;
const OBSERVATIONS_POLL_MS = 30_000;

type FlowPage = 'order-flow' | 'strike-flow' | 'observations';

/** How many observation cards the advisor is holding (for the tab's count figure). */
function useObservationCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetch(OBSERVATIONS_URL).then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))).then(body => {
        if (alive) setCount(Array.isArray(body?.cards) ? body.cards.length : 0);
      }).catch(() => { /* the page itself surfaces failures; the count just waits */ });
    };
    read();
    const timer = setInterval(read, OBSERVATIONS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return count;
}

export default function App() {
  const [universe, setUniverse] = useState<Underlying[]>([]);
  const [page, setPage] = useState<FlowPage>('order-flow');
  const observationCount = useObservationCount();
  useEffect(() => { loadUnderlyings().then(setUniverse); }, []);
  const flowPages: CapsuleOption<FlowPage>[] = [
    { value: 'order-flow', label: 'Order Flow' },
    { value: 'strike-flow', label: 'Option Board' },
    { value: 'observations', label: 'Observations', count: observationCount || undefined, title: observationCount ? `${observationCount} observation card(s) from the advisor` : 'No observation cards yet' },
  ];
  const tabs = (
    <CapsuleSegmented options={flowPages} value={page} onChange={setPage} ariaLabel="Flow boards" groupId="app-flow-tabs" role="tablist" size="page" />
  );
  // All pages carry the tabs inside their own bar row (reference header) — no strip above.
  const label = page === 'order-flow' ? 'Order Flow board' : page === 'strike-flow' ? 'Strike Flow board' : 'Observations board';
  return (
    <div className="app-flow-shell">
      <div className="app-flow-panel" role="tabpanel" aria-label={label} tabIndex={0}>
        {page === 'order-flow' ? <MarketFlowPage universe={universe} tabs={tabs} /> : page === 'strike-flow' ? <StrikeFlowPage universe={universe} tabs={tabs} /> : <ObservationsPage tabs={tabs} />}
      </div>
    </div>
  );
}
