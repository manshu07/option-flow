import { useEffect, useState } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { MarketFlowPage } from '@/features/market-flow/MarketFlowPage';
import { StrikeFlowPage } from '@/features/strike-flow/StrikeFlowPage';
import { ObservationsPage } from '@/features/observations/ObservationsPage';
import { loadUnderlyings, type Underlying } from '@/lib/underlyings';

type FlowPage = 'order-flow' | 'strike-flow' | 'observations';
const FLOW_PAGES: CapsuleOption<FlowPage>[] = [
  { value: 'order-flow', label: 'Order Flow' },
  { value: 'strike-flow', label: 'Option Board' },
  { value: 'observations', label: 'Observations' },
];

export default function App() {
  const [universe, setUniverse] = useState<Underlying[]>([]);
  const [page, setPage] = useState<FlowPage>('order-flow');
  useEffect(() => { loadUnderlyings().then(setUniverse); }, []);
  const tabs = (
    <CapsuleSegmented options={FLOW_PAGES} value={page} onChange={setPage} ariaLabel="Flow boards" groupId="app-flow-tabs" role="tablist" size="page" />
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
