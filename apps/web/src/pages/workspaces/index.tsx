import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { WalletOperationsPage } from '../wallet-operations';
import './workspaces.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export { AgentOverview } from './agent-overview';

type Access = { role: string; admin: boolean; agent: boolean; agentStatus: string | null };
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));
export function useWorkspaceAccess() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['workspace-access', user?.id],
    queryFn: () => get<Access>('/workspaces/access'),
    enabled: !!user,
    retry: false,
    refetchInterval: 30000,
  });
}
export function WorkspaceGate({
  kind,
  children,
}: {
  kind: 'admin' | 'agent';
  children: ReactNode;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  const { user, isLoading } = useAuth();
  const location = useLocation();
  const access = useWorkspaceAccess();
  // Gate the matched route, not the raw URL spelling: React Router also accepts
  // case variants and encoded segments. Never redirect an unresolved member.
  if (isLoading)
    return (
      <div className="workspace-status" role="status">
        {translateUi('Checking workspace access…')}
      </div>
    );
  if (!user) return <Navigate to={`/${kind}/login`} state={{ from: location }} replace />;
  if (access.isPending)
    return (
      <div className="workspace-status" role="status">
        {translateUi('Checking workspace access…')}
      </div>
    );
  if (access.isError)
    return (
      <div className="workspace-status" role="alert">
        <h1>{translateUi('Access could not be verified')}</h1>
        <button onClick={() => access.refetch()}>{translateUi('Try again')}</button>
        <Link to="/">{translateUi('Member home')}</Link>
      </div>
    );
  if (!access.data[kind])
    return (
      <div className="workspace-status">
        <h1>
          {kind === 'admin'
            ? translateUi('Administrator access required')
            : translateUi('Approved agent access required')}
        </h1>
        <p>
          {kind === 'admin'
            ? translateUi('This account does not have administrator permission.')
            : translateUi(
                'Agent status: {value}. An administrator must approve your application.',
                {
                  value: access.data.agentStatus
                    ? interfaceCodeLabel(translateUi, access.data.agentStatus)
                    : translateUi('Not registered'),
                }
              )}
        </p>
        {kind === 'agent' && (
          <Link to="/wallet/agent-setup">{translateUi('Agent application')}</Link>
        )}
        <Link to="/">{translateUi('Member home')}</Link>
        <Link to={`/${kind}/login`}>{translateUi('Use another account')}</Link>
      </div>
    );
  return <>{children}</>;
}
const adminLinks = [
  ['/admin/group-play', 'Group play controls'],
  ['/admin', 'Overview'],
  ['/admin/support', 'Support inbox'],
  ['/admin/rewards', 'Reward control'],
  ['/admin/payments', 'Payment configuration'],
  ['/admin/pricing', 'Rates & packages'],
  ['/admin/crypto', 'Crypto payments'],
  ['/admin/disputes', 'Disputes'],
  ['/admin/accounts', 'Accounts'],
  ['/admin/agents', 'Agents'],
  ['/admin/agents/new', 'Create agent'],
  ['/admin/games', 'Game catalog'],
  ['/admin/activity', 'Audit history'],
  ['/admin/profile', 'My account & security'],
];
const agentLinks = [
  ['/agent', 'Overview'],
  ['/agent/operations', 'Deposits & payouts'],
  ['/agent/accounts', 'Receiving accounts'],
  ['/agent/profile', 'My account & security'],
  ['/agent/support', 'Support'],
];
export function WorkspaceLayout({ kind }: { kind: 'admin' | 'agent' }) {
  const { t: translateUi } = useInterfaceLanguage();

  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-shell">
      <a className="workspace-skip" href="#workspace-main">
        {translateUi('Skip to content')}
      </a>
      <aside className={open ? 'workspace-sidebar open' : 'workspace-sidebar'}>
        <Link className="workspace-brand" to={`/${kind}`}>
          {translateUi('Salem Bet')}
          <span>
            {kind === 'admin' ? translateUi('ADMINISTRATION') : translateUi('AGENT WORKSPACE')}
          </span>
        </Link>
        <nav
          aria-label={translateUi('{kind} navigation', {
            kind: translateUi(kind === 'admin' ? 'Administrator' : 'Agent'),
          })}
        >
          {(kind === 'admin' ? adminLinks : agentLinks).map(([to, label]) => (
            <NavLink key={to} to={to} end onClick={() => setOpen(false)}>
              {translateUi(label)}
            </NavLink>
          ))}
        </nav>
        <div className="workspace-identity">
          <strong>{user?.displayName || user?.username}</strong>
          <span>{user?.email}</span>
          <p>
            {kind === 'admin'
              ? translateUi('Platform administration')
              : translateUi('Payment agent')}
          </p>
          <button onClick={() => void logout()}>{translateUi('Sign out')}</button>
          <Link to="/">{translateUi('Open member app')}</Link>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <button className="workspace-menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? translateUi('Close menu') : translateUi('Menu')}
          </button>
          <span>
            {kind === 'admin' ? translateUi('Control center') : translateUi('Agent services')}
          </span>
          <span className="workspace-badge">
            {kind === 'admin' ? translateUi('Administrator') : translateUi('Approved agent')}
          </span>
        </header>
        <main id="workspace-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
function QueryState({
  query,
  children,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  children: ReactNode;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  if (query.isPending)
    return (
      <p role="status" className="workspace-panel">
        {translateUi('Loading current data…')}
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="workspace-panel">
        {translateUi('Could not load this section.') + ' '}
        <button onClick={() => query.refetch()}>{translateUi('Retry')}</button>
      </div>
    );
  return <>{children}</>;
}
export function AdminOverview() {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['admin-overview', user?.id],
    queryFn: () => get<Record<string, number | string>>('/workspaces/admin/overview'),
    refetchInterval: 30000,
  });
  const metrics = [
    ['members', 'Member accounts'],
    ['agents', 'Active agents'],
    ['groups', 'Active groups'],
    ['games', 'Catalog games'],
  ];
  return (
    <>
      <div className="workspace-heading">
        <p>{translateUi('PLATFORM OVERVIEW')}</p>
        <h1>{translateUi('Administration dashboard')}</h1>
        <span>
          {translateUi('Monitor the platform and manage payment operations in one place.')}
        </span>
      </div>
      <QueryState query={query}>
        <div className="workspace-metrics">
          {metrics.map(([key, label]) => (
            <article key={key}>
              <span>{translateUi(label)}</span>
              <strong>{query.data?.[key]}</strong>
            </article>
          ))}
        </div>
        <section className="workspace-panel">
          <h2>{translateUi('Needs attention')}</h2>
          <div className="workspace-tasks">
            <Link to="/admin/support">
              <strong>{query.data?.support ?? '—'}</strong>
              <span>{translateUi('Support requests awaiting reply')}</span>
            </Link>
            <Link to="/admin/payments">
              <strong>{query.data?.applications}</strong>
              <span>{translateUi('Agent applications')}</span>
            </Link>
            <Link to="/admin/payments">
              <strong>{query.data?.accounts}</strong>
              <span>{translateUi('Receiving accounts to review')}</span>
            </Link>
            <Link to="/admin/payments">
              <strong>{query.data?.countries}</strong>
              <span>{translateUi('Countries enabled for payments')}</span>
            </Link>
          </div>
          <p>
            {translateUi(
              'Country activation alone does not make payments ready. Verified rates, approved accounts and backed liquidity are required.'
            )}
          </p>
        </section>
        <p className="workspace-muted">
          {translateUi('Updated {value}', {
            value: query.data?.asOf
              ? new Date(String(query.data.asOf)).toLocaleString(interfaceLocale)
              : '—',
          })}
        </p>
      </QueryState>
      <div className="workspace-grid">
        <Link className="workspace-panel workspace-shortcut" to="/admin/payments">
          <h2>{translateUi('Payment operations')}</h2>
          <p>{translateUi('Countries, methods, agents, receiving accounts and funding.')}</p>
          <span>{translateUi('Manage payments →')}</span>
        </Link>
        <Link className="workspace-panel workspace-shortcut" to="/admin/activity">
          <h2>{translateUi('Accountability')}</h2>
          <p>{translateUi('Review the latest recorded administrative actions.')}</p>
          <span>{translateUi('Open audit history →')}</span>
        </Link>
      </div>
      <section className="workspace-panel">
        <h2>{translateUi('Permission boundaries')}</h2>
        <p>
          {translateUi(
            'Administrators manage configuration and operational reviews. Financial adjustments remain restricted to super administrators. Member activity and agent access can be managed from their account pages. Account roles and game rules remain protected.'
          )}
        </p>
      </section>
    </>
  );
}
type AccountRow = {
  id: string;
  username: string;
  email: string | null;
  role: string;
  status: string;
  createdAt: string;
  agentProfile?: { status: string } | null;
};
export function AdminAccounts() {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { user } = useAuth();
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [q, setQ] = useState('');
  const query = useQuery({
    queryKey: ['admin-accounts', user?.id, page, q],
    queryFn: () =>
      get<{ rows: AccountRow[]; total: number; pageSize: number }>(
        `/workspaces/admin/accounts?page=${page}&q=${encodeURIComponent(q)}`
      ),
  });
  return (
    <>
      <div className="workspace-heading">
        <p>{translateUi('ACCOUNT DIRECTORY')}</p>
        <h1>{translateUi('Accounts')}</h1>
        <span>
          {translateUi(
            'Inspect member and staff accounts. Agent approval is managed under Payment configuration.'
          )}
        </span>
      </div>
      <form
        className="workspace-search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(search.trim());
        }}
      >
        <label htmlFor="account-search">{translateUi('Username or email')}</label>
        <input
          id="account-search"
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button>{translateUi('Search')}</button>
      </form>
      <QueryState query={query}>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>{translateUi('Account')}</th>
                <th>{translateUi('Role')}</th>
                <th>{translateUi('Agent profile')}</th>
                <th>{translateUi('Status')}</th>
                <th>{translateUi('Joined')}</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/accounts/${r.id}`}>
                      <strong>{r.username}</strong>
                    </Link>
                    <small>{r.email ?? translateUi('No email')}</small>
                  </td>
                  <td>{interfaceCodeLabel(translateUi, r.role)}</td>
                  <td>
                    {r.agentProfile ? interfaceCodeLabel(translateUi, r.agentProfile.status) : '—'}
                  </td>
                  <td>{interfaceCodeLabel(translateUi, r.status)}</td>
                  <td>{new Date(r.createdAt).toLocaleDateString(interfaceLocale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!query.data?.rows.length && <p>{translateUi('No matching accounts.')}</p>}
        </div>
        <div className="workspace-pagination">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            {translateUi('Previous')}
          </button>
          <span>
            {translateUi('Page {page} · {total} accounts', {
              page: page,
              total: query.data?.total ?? '',
            })}
          </span>
          <button
            disabled={!query.data || page * query.data.pageSize >= query.data.total}
            onClick={() => setPage(page + 1)}
          >
            {translateUi('Next')}
          </button>
        </div>
      </QueryState>
    </>
  );
}
export function AdminRecords({ kind }: { kind: 'games' | 'audit' }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['admin-records', user?.id, kind],
    queryFn: () =>
      get<Array<Record<string, string | boolean | number | null>>>(`/workspaces/admin/${kind}`),
  });
  const columns =
    kind === 'games'
      ? [
          ['name', 'Game'],
          ['mode', 'Mode'],
          ['catalogStatus', 'Catalog status'],
          ['isActive', 'Enabled'],
          ['currentRulesVersion', 'Rules version'],
        ]
      : [
          ['createdAt', 'Time'],
          ['action', 'Action'],
          ['entity', 'Resource'],
          ['entityId', 'Reference'],
          ['userId', 'Actor'],
        ];
  return (
    <>
      <div className="workspace-heading">
        <p>
          {kind === 'games'
            ? translateUi('CATALOG OVERSIGHT')
            : translateUi('ADMINISTRATIVE RECORDS')}
        </p>
        <h1>{kind === 'games' ? translateUi('Game catalog') : translateUi('Audit history')}</h1>
        <span>
          {kind === 'games'
            ? translateUi(
                'Read-only catalog status. Game availability also depends on runtime admission rules.'
              )
            : translateUi(
                'Latest 100 audit events. Sensitive payloads and credentials are excluded.'
              )}
        </span>
      </div>
      <QueryState query={query}>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                {columns.map(([key, label]) => (
                  <th key={key}>{translateUi(label)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data?.map((r) => (
                <tr key={String(r.id)}>
                  {columns.map(([key]) => (
                    <td key={key}>
                      {key === 'createdAt'
                        ? new Date(String(r[key])).toLocaleString(interfaceLocale)
                        : typeof r[key] === 'boolean'
                          ? r[key]
                            ? translateUi('Yes')
                            : translateUi('No')
                          : key === 'name'
                            ? translateUi(String(r[key] ?? '—'))
                            : ['mode', 'catalogStatus'].includes(key)
                              ? interfaceCodeLabel(translateUi, String(r[key] ?? '—'))
                              : String(r[key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!query.data?.length && <p>{translateUi('No records to display.')}</p>}
        </div>
      </QueryState>
    </>
  );
}
export function WorkspaceProcessing({ kind }: { kind: 'admin' | 'agent' }) {
  return <WalletOperationsPage workspace={kind} />;
}

export function WorkspaceDestination() {
  const { t: translateUi } = useInterfaceLanguage();

  const access = useWorkspaceAccess();
  if (access.isPending) return <p role="status">{translateUi('Checking workspace access…')}</p>;
  if (access.isError)
    return (
      <p role="alert">
        {translateUi('Could not verify access.') + ' '}
        <button onClick={() => access.refetch()}>{translateUi('Retry')}</button>
      </p>
    );
  if (access.data.admin) return <Navigate to="/admin" replace />;
  if (access.data.agent) return <Navigate to="/agent" replace />;
  return (
    <section>
      <h1>{translateUi('Staff access required')}</h1>
      <p>{translateUi('Use your approved agent or administrator account.')}</p>
      <Link to="/wallet/agent-setup">{translateUi('Apply to become an agent')}</Link>
    </section>
  );
}
