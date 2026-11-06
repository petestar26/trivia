import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const {
    t: translateUi,
    formatMinorCurrency: formatMoney,
    locale: interfaceLocale,
  } = useInterfaceLanguage();

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
        {translateUi('Loading your agent workspace…')}
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="workspace-panel">
        {translateUi('Your agent overview could not load.') + ' '}
        <button onClick={() => query.refetch()}>{translateUi('Retry')}</button>
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
        <p>{translateUi('YOUR AGENT WORKSPACE')}</p>
        <h1>{translateUi('Welcome, {displayName}', { displayName: d.agent.displayName })}</h1>
        <span>
          {d.country.name} · {d.agent.contactEmail}
        </span>
      </header>
      <div className="workspace-metrics">
        <Link to="/agent/operations">
          <span>{translateUi('Deposits to verify')}</span>
          <strong>{d.deposits.PAYMENT_SUBMITTED ?? 0}</strong>
        </Link>
        <Link to="/agent/operations">
          <span>{translateUi('Payouts to process')}</span>
          <strong>{(d.payouts.HELD ?? 0) + (d.payouts.PAYOUT_IN_PROGRESS ?? 0)}</strong>
        </Link>
        <Link to="/agent/accounts">
          <span>{translateUi('Receiving accounts in review')}</span>
          <strong>{d.setup.pendingAccounts}</strong>
        </Link>
        <article>
          <span>{translateUi('Completed payments')}</span>
          <strong>{(d.deposits.COMPLETED ?? 0) + (d.payouts.COMPLETED ?? 0)}</strong>
        </article>
      </div>
      <div className="workspace-grid">
        <section className="workspace-panel">
          <h2>{translateUi('Operating balances')}</h2>
          <dl className="workspace-facts">
            <div>
              <dt>{translateUi('Available for deposits')}</dt>
              <dd>{formatMoney(d.inventory.available)}</dd>
            </div>
            <div>
              <dt>{translateUi('Reserved for deposits')}</dt>
              <dd>{formatMoney(d.inventory.reserved)}</dd>
            </div>
            {d.liquidity.map((l) => (
              <div key={l.currency}>
                <dt>
                  {translateUi('Available payout funds · {currency}', { currency: l.currency })}
                </dt>
                <dd>
                  {formatMoney(l.available, l.currency)}
                  <small>
                    {translateUi('{value} reserved', {
                      value: formatMoney(l.reserved, l.currency),
                    })}
                  </small>
                </dd>
              </div>
            ))}
          </dl>
          {!d.liquidity.length && <p>{translateUi('No payout liquidity has been allocated.')}</p>}
          <p className="workspace-muted">
            {translateUi('These are agent operating balances. Your member wallet is separate.')}
          </p>
        </section>
        <section className="workspace-panel">
          <h2>{translateUi('Payment setup')}</h2>
          <ul className="workspace-checks">
            {checks.map(([label, ready]) => (
              <li key={label}>
                <span>{translateUi(label)}</span>
                <strong className={ready ? 'is-ready' : 'needs-setup'}>
                  {ready ? translateUi('Ready') : translateUi('Needs setup')}
                </strong>
              </li>
            ))}
          </ul>
          <p>
            {translateUi(
              'Each payment also checks the member’s eligibility, amount limits and current financial policy.'
            )}
          </p>
          <Link to="/agent/accounts">{translateUi('Manage receiving accounts →')}</Link>
        </section>
      </div>
      <section className="workspace-panel">
        <h2>{translateUi('Recent assigned payments')}</h2>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>{translateUi('Reference')}</th>
                <th>{translateUi('Type')}</th>
                <th>{translateUi('ETB amount')}</th>
                <th>{translateUi('Status')}</th>
                <th>{translateUi('Created')}</th>
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
                    <td>{translateUi(staffLabel(p.type))}</td>
                    <td>{formatMoney(p.coinAmount)}</td>
                    <td>{translateUi(staffLabel(p.status))}</td>
                    <td>{new Date(p.createdAt).toLocaleString(interfaceLocale)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!d.recentDeposits.length && !d.recentPayouts.length && (
          <p>{translateUi('No assigned payments yet.')}</p>
        )}
        <Link to="/agent/operations">{translateUi('Open deposits & payouts →')}</Link>
      </section>
      <p className="workspace-muted">
        {translateUi('Updated') + ' '}
        {new Date(d.asOf).toLocaleString(interfaceLocale)}{' '}
        <button disabled={query.isFetching} onClick={() => query.refetch()}>
          {translateUi('Refresh overview')}
        </button>
      </p>
    </>
  );
}
