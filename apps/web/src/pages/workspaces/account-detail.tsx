import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { staffLabel } from './agent-overview';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

type Payment = {
  id: string;
  orderNumber?: string;
  withdrawalNumber?: string;
  status: string;
  coinAmount: number;
  createdAt: string;
};
type Detail = {
  account: {
    id: string;
    username: string;
    email: string | null;
    displayName: string | null;
    phone: string | null;
    phoneVerified: boolean;
    role: string;
    status: string;
    updatedAt: string;
    isVerified: boolean;
    createdAt: string;
    lastLoginAt: string | null;
    kycVerification: { status: string; verifiedTier: number } | null;
    agentProfile: {
      id: string;
      displayName: string;
      status: string;
      suspendedReason: string | null;
      country: { name: string };
    } | null;
  };
  canChangeStatus: boolean;
  wallet: {
    balance: number;
    practicePoints: number;
    spendable: number;
    betOnly: number;
    reserved: number;
    pendingReview: number;
  } | null;
  deposits: Payment[];
  withdrawals: Payment[];
  transactions: Array<{
    id: string;
    amount: number;
    currency: string;
    type: string;
    status: string;
    createdAt: string;
  }>;
  audit: Array<{ id: string; action: string; entity: string; createdAt: string }>;
  asOf: string;
};
export function AdminAccountDetail() {
  const {
    t: translateUi,
    formatMinorCurrency: formatMoney,
    locale: interfaceLocale,
  } = useInterfaceLanguage();

  const { id } = useParams();
  const { user } = useAuth();
  const cache = useQueryClient();
  const active = useRef(false);
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: ['admin-account-detail', user?.id, id],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) => api.get<Detail>(`/workspaces/admin/accounts/${id}`, undefined, { signal: s }),
          signal
        )
      ),
    retry: false,
  });
  useEffect(() => {
    setConfirmed(false);
  }, [query.data?.account.updatedAt, id]);
  async function changeStatus(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || !query.data?.canChangeStatus || !confirmed || reason.trim().length < 5)
      return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      const account = query.data.account;
      unwrapData(
        await boundedRequest((signal) =>
          api.post(
            `/workspaces/admin/accounts/${id}/status`,
            {
              status: account.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
              reason: reason.trim(),
              expectedUpdatedAt: account.updatedAt,
            },
            undefined,
            { signal }
          )
        )
      );
      setNotice('Account status updated.');
      setReason('');
      for (const queryKey of [
        ['admin-account-detail'],
        ['admin-accounts'],
        ['admin-agents'],
        ['admin-overview'],
      ])
        void cache.invalidateQueries({ queryKey });
    } catch (error) {
      const status = getErrorStatus(error);
      setNotice(
        status && status >= 400 && status < 500
          ? getErrorMessage(error, 'The account could not be updated.')
          : 'The update could not be confirmed. Check the refreshed status before trying again.'
      );
      await query.refetch();
    } finally {
      active.current = false;
      setBusy(false);
      setConfirmed(false);
    }
  }
  if (query.isPending)
    return (
      <p role="status" className="workspace-panel">
        {translateUi('Loading account details…')}
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="workspace-panel">
        <h1>{translateUi('Account could not be loaded')}</h1>
        <button onClick={() => query.refetch()}>{translateUi('Retry')}</button>{' '}
        <Link to="/admin/accounts">{translateUi('Back to accounts')}</Link>
      </div>
    );
  const d = query.data,
    a = d.account,
    w = d.wallet;
  const facts = [
    ['Username', a.username],
    ['Email', a.email || translateUi('Not added')],
    [
      'Phone',
      a.phone
        ? `${a.phone} · ${translateUi(a.phoneVerified ? 'Verified' : 'Not verified')}`
        : translateUi('Not added'),
    ],
    ['Role', translateUi(staffLabel(a.role))],
    ['Status', translateUi(staffLabel(a.status))],
    ['Joined', new Date(a.createdAt).toLocaleString(interfaceLocale)],
    [
      'Last sign-in',
      a.lastLoginAt
        ? new Date(a.lastLoginAt).toLocaleString(interfaceLocale)
        : translateUi('Not recorded'),
    ],
    [
      'Identity verification',
      a.kycVerification
        ? translateUi('{status} · Tier {tier}', {
            status: translateUi(staffLabel(a.kycVerification.status)),
            tier: a.kycVerification.verifiedTier,
          })
        : translateUi('Not submitted'),
    ],
  ];
  return (
    <>
      <header className="workspace-heading">
        <p>{translateUi('MEMBER ACCOUNT')}</p>
        <h1>{a.displayName || a.username}</h1>
        <span>
          @{a.username} · {translateUi(staffLabel(a.status))}
        </span>
        <Link to="/admin/accounts">{translateUi('← Account directory')}</Link>
      </header>
      <div className="workspace-grid">
        <section className="workspace-panel">
          <h2>{translateUi('Account information')}</h2>
          <dl className="workspace-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{translateUi(String(label))}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="workspace-panel">
          <h2>{translateUi('Wallet overview')}</h2>
          {w ? (
            <dl className="workspace-facts">
              {[
                ['Wallet balance', w.balance],
                ['Available cash balance', w.spendable],
                ['Bet-only rewards', w.betOnly],
                ['Reserved', w.reserved],
                ['Pending review', w.pendingReview],
              ].map(([label, amount]) => (
                <div key={String(label)}>
                  <dt>{translateUi(String(label))}</dt>
                  <dd>{formatMoney(Number(amount))}</dd>
                </div>
              ))}
              <div>
                <dt>{translateUi('Practice points')}</dt>
                <dd>{w.practicePoints.toLocaleString(interfaceLocale)}</dd>
              </div>
            </dl>
          ) : (
            <p>{translateUi('This member has not opened a wallet.')}</p>
          )}
          <p className="workspace-muted">
            {translateUi(
              'Bet-only rewards cannot be withdrawn. Cash withdrawals still require eligibility checks.'
            )}
          </p>
        </section>
      </div>
      {notice && (
        <p role="status" className="workspace-panel">
          {translateUi(notice)}
        </p>
      )}
      {d.canChangeStatus && (
        <section className="workspace-panel">
          <h2>
            {a.status === 'ACTIVE'
              ? translateUi('Suspend member activity')
              : translateUi('Reactivate member account')}
          </h2>
          <p>
            {translateUi(
              'Financial records and balances are preserved. Suspension blocks new account activity and removes refresh sessions.'
            )}
          </p>
          <form className="workspace-account-form" onSubmit={changeStatus}>
            <label>
              {translateUi('Account status reason')}
              <textarea
                required
                minLength={5}
                maxLength={500}
                value={reason}
                disabled={busy}
                onChange={(e) => {
                  setReason(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label className="workspace-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || query.isFetching}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {translateUi('I reviewed this member and authorize the status change.')}
            </label>
            <button disabled={busy || query.isFetching || !confirmed || reason.trim().length < 5}>
              {busy
                ? translateUi('Updating account…')
                : a.status === 'ACTIVE'
                  ? translateUi('Suspend member')
                  : translateUi('Reactivate member')}
            </button>
          </form>
        </section>
      )}
      <section className="workspace-panel">
        <h2>{translateUi('Agent access')}</h2>
        {a.agentProfile ? (
          <>
            <p>
              {a.agentProfile.displayName} · {translateUi(staffLabel(a.agentProfile.status))} ·{' '}
              {a.agentProfile.country.name}
            </p>
            {a.agentProfile.suspendedReason && <p>{a.agentProfile.suspendedReason}</p>}
            <Link to={`/admin/agents?q=${encodeURIComponent(a.email || a.username)}`}>
              {translateUi('Manage this agent →')}
            </Link>
          </>
        ) : (
          <>
            <p>{translateUi('This account has no agent profile.')}</p>
            {a.role === 'USER' && a.status === 'ACTIVE' && (
              <Link to="/admin/agents/new">
                {translateUi('Approve an existing member as an agent →')}
              </Link>
            )}
          </>
        )}
      </section>
      <section className="workspace-panel">
        <h2>{translateUi('Recent deposits & withdrawals')}</h2>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>{translateUi('Reference')}</th>
                <th>{translateUi('Type')}</th>
                <th>{translateUi('Amount')}</th>
                <th>{translateUi('Status')}</th>
                <th>{translateUi('Created')}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...d.deposits.map((p) => ({ ...p, kind: 'Deposit' })),
                ...d.withdrawals.map((p) => ({ ...p, kind: 'Withdrawal' })),
              ]
                .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
                .map((p) => (
                  <tr key={p.id}>
                    <td>{p.orderNumber || p.withdrawalNumber}</td>
                    <td>{translateUi(p.kind)}</td>
                    <td>{formatMoney(p.coinAmount)}</td>
                    <td>{translateUi(staffLabel(p.status))}</td>
                    <td>{new Date(p.createdAt).toLocaleString(interfaceLocale)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!d.deposits.length && !d.withdrawals.length && <p>{translateUi('No payment history.')}</p>}
        <p className="workspace-muted">
          {translateUi(
            'Latest 15 records of each type. Payment reviews remain in Payment configuration and Disputes.'
          )}
        </p>
      </section>
      <section className="workspace-panel">
        <h2>{translateUi('Recent wallet activity')}</h2>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>{translateUi('Type')}</th>
                <th>{translateUi('Amount')}</th>
                <th>{translateUi('Status')}</th>
                <th>{translateUi('Time')}</th>
              </tr>
            </thead>
            <tbody>
              {d.transactions.map((t) => (
                <tr key={t.id}>
                  <td>{translateUi(staffLabel(t.type))}</td>
                  <td>
                    {t.currency === 'COINS'
                      ? formatMoney(t.amount)
                      : translateUi('{value} practice points', {
                          value: t.amount.toLocaleString(interfaceLocale),
                        })}
                  </td>
                  <td>{translateUi(staffLabel(t.status))}</td>
                  <td>{new Date(t.createdAt).toLocaleString(interfaceLocale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!d.transactions.length && <p>{translateUi('No wallet activity.')}</p>}
      </section>
      <section className="workspace-panel">
        <h2>{translateUi('Account audit history')}</h2>
        {d.audit.length ? (
          <ul className="workspace-history">
            {d.audit.map((event) => (
              <li key={event.id}>
                <span>{translateUi(staffLabel(event.action))}</span>
                <time>{new Date(event.createdAt).toLocaleString(interfaceLocale)}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p>{translateUi('No recorded administrative activity.')}</p>
        )}
      </section>
      <p className="workspace-muted">
        {translateUi('Updated') + ' '}
        {new Date(d.asOf).toLocaleString(interfaceLocale)}{' '}
        <button disabled={query.isFetching} onClick={() => query.refetch()}>
          {translateUi('Refresh account')}
        </button>
      </p>
    </>
  );
}
