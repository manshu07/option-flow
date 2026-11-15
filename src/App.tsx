import { useEffect, useState } from 'react';
import { CapsuleSegmented, type CapsuleOption } from '@/components/common/CapsuleSegmented';
import { MarketFlowPage } from '@/features/market-flow/MarketFlowPage';
import { StrikeFlowPage } from '@/features/strike-flow/StrikeFlowPage';
import { loadUnderlyings, type Underlying } from '@/lib/underlyings';

type FlowPage = 'order-flow' | 'strike-flow';
const FLOW_PAGES: CapsuleOption<FlowPage>[] = [
  { value: 'order-flow', label: 'Order Flow' },
  { value: 'strike-flow', label: 'Option Board' },
];

export default function App() {
  const [universe, setUniverse] = useState<Underlying[]>([]);
  const [page, setPage] = useState<FlowPage>('order-flow');
  useEffect(() => { loadUnderlyings().then(setUniverse); }, []);
  const tabs = (
    <CapsuleSegmented options={FLOW_PAGES} value={page} onChange={setPage} ariaLabel="Flow boards" groupId="app-flow-tabs" role="tablist" size="page" />
  );
  // Both pages carry the tabs inside their own bar row (reference header) — no strip above.
  return (
    <div className="app-flow-shell">
      <div className="app-flow-panel" role="tabpanel" aria-label={page === 'order-flow' ? 'Order Flow board' : 'Strike Flow board'} tabIndex={0}>
        {page === 'order-flow' ? <MarketFlowPage universe={universe} tabs={tabs} /> : <StrikeFlowPage universe={universe} tabs={tabs} />}
      </div>
    </div>
  );
}
