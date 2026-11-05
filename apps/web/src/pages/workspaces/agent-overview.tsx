import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { formatEtb, formatMinor } from '@/lib/payment-money';
type Overview = {
  agent: { displayName: string; contactEmail: string; contactPhone: string | null };
  country: { name: string; currencyCode: string };
  deposits: Record<string, number>;
  payouts: Record<string, number>;
  inventory: { total: number; reserved: number; available: number };
  liquidity: Array<{ currency: string; total: string; reserved: string; available: string }>;
  setup: {
    countryActive: boolean;
    paymentsEnabled: boolean;
    rateReady: boolean;
    approvedAccounts: number;
    pendingAccounts: number;
    hasDepositFunding: boolean;
    hasPayoutLiquidity: boolean;
  };
  recentDeposits: Array<{
    id: string;
    orderNumber: string;
    status: string;
    coinAmount: number;
    createdAt: string;
  }>;
  recentPayouts: Array<{
    id: string;
    withdrawalNumber: string;
    status: string;
    coinAmount: number;
    createdAt: string;
  }>;
  asOf: string;
};
export const staffLabel = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
export function AgentOverview() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['agent-overview', user?.id],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) => api.get<Overview>('/workspaces/agent/overview', undefined, { signal: s }),
          signal
        )
      ),
    retry: false,
    refetchInterval: 30000,
  });
  if (query.isPending)
    return (
      <p role="status" className="workspace-panel">
        Loading your agent workspace…
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="workspace-panel">
        Your agent overview could not load. <button onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  const d = query.data;
  const checks = [
    ['Country available', d.setup.countryActive],
    ['Customer payments enabled', d.setup.paymentsEnabled],
    ['Current payment rate', d.setup.rateReady],
    ['Approved receiving account', d.setup.approvedAccounts > 0],
    ['Available deposit funding', d.setup.hasDepositFunding],
    ['Available payout liquidity', d.setup.hasPayoutLiquidity],
  ] as const;
  return (
    <>
      <header className="workspace-heading">
        <p>YOUR AGENT WORKSPACE</p>
        <h1>Welcome, {d.agent.displayName}</h1>
        <span>
          {d.country.name} · {d.agent.contactEmail}
        </span>
      </header>
      <div className="workspace-metrics">
        <Link to="/agent/operations">
          <span>Deposits to verify</span>
          <strong>{d.deposits.PAYMENT_SUBMITTED ?? 0}</strong>
        </Link>
        <Link to="/agent/operations">
          <span>Payouts to process</span>
          <strong>{(d.payouts.HELD ?? 0) + (d.payouts.PAYOUT_IN_PROGRESS ?? 0)}</strong>
        </Link>
        <Link to="/agent/accounts">
          <span>Receiving accounts in review</span>
          <strong>{d.setup.pendingAccounts}</strong>
        </Link>
        <article>
          <span>Completed payments</span>
          <strong>{(d.deposits.COMPLETED ?? 0) + (d.payouts.COMPLETED ?? 0)}</strong>
        </article>
      </div>
      <div className="workspace-grid">
        <section className="workspace-panel">
          <h2>Operating balances</h2>
          <dl className="workspace-facts">
            <div>
              <dt>Available for deposits</dt>
              <dd>{formatEtb(d.inventory.available)}</dd>
            </div>
            <div>
              <dt>Reserved for deposits</dt>
              <dd>{formatEtb(d.inventory.reserved)}</dd>
            </div>
            {d.liquidity.map((l) => (
              <div key={l.currency}>
                <dt>Available payout funds · {l.currency}</dt>
                <dd>
                  {formatMinor(l.available, l.currency)}
                  <small>{formatMinor(l.reserved, l.currency)} reserved</small>
                </dd>
              </div>
            ))}
          </dl>
          {!d.liquidity.length && <p>No payout liquidity has been allocated.</p>}
          <p className="workspace-muted">
            These are agent operating balances. Your member wallet is separate.
          </p>
        </section>
        <section className="workspace-panel">
          <h2>Payment setup</h2>
          <ul className="workspace-checks">
            {checks.map(([label, ready]) => (
              <li key={label}>
                <span>{label}</span>
                <strong className={ready ? 'is-ready' : 'needs-setup'}>
                  {ready ? 'Ready' : 'Needs setup'}
                </strong>
              </li>
            ))}
          </ul>
          <p>
            Each payment also checks the member’s eligibility, amount limits and current financial
            policy.
          </p>
          <Link to="/agent/accounts">Manage receiving accounts →</Link>
        </section>
      </div>
      <section className="workspace-panel">
        <h2>Recent assigned payments</h2>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Type</th>
                <th>ETB amount</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...d.recentDeposits.map((p) => ({
                  ...p,
                  reference: p.orderNumber,
                  type: 'Deposit',
                })),
                ...d.recentPayouts.map((p) => ({
                  ...p,
                  reference: p.withdrawalNumber,
                  type: 'Payout',
                })),
              ]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((p) => (
                  <tr key={p.id}>
                    <td>{p.reference}</td>
                    <td>{p.type}</td>
                    <td>{formatEtb(p.coinAmount)}</td>
                    <td>{staffLabel(p.status)}</td>
                    <td>{new Date(p.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!d.recentDeposits.length && !d.recentPayouts.length && <p>No assigned payments yet.</p>}
        <Link to="/agent/operations">Open deposits & payouts →</Link>
      </section>
      <p className="workspace-muted">
        Updated {new Date(d.asOf).toLocaleString()}{' '}
        <button disabled={query.isFetching} onClick={() => query.refetch()}>
          Refresh overview
        </button>
      </p>
    </>
  );
}
