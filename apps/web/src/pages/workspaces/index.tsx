import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { api, unwrapData } from '@/lib/api';
import { WalletOperationsPage } from '../wallet-operations';
import './workspaces.css';

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
  const { user } = useAuth();
  const location = useLocation();
  const access = useWorkspaceAccess();
  if (!user) return <Navigate to={`/${kind}/login`} state={{ from: location }} replace />;
  if (access.isPending)
    return (
      <div className="workspace-status" role="status">
        Checking workspace access…
      </div>
    );
  if (access.isError)
    return (
      <div className="workspace-status" role="alert">
        <h1>Access could not be verified</h1>
        <button onClick={() => access.refetch()}>Try again</button>
        <Link to="/">Member home</Link>
      </div>
    );
  if (!access.data[kind])
    return (
      <div className="workspace-status">
        <h1>
          {kind === 'admin' ? 'Administrator access required' : 'Approved agent access required'}
        </h1>
        <p>
          {kind === 'admin'
            ? 'This account does not have administrator permission.'
            : `Agent status: ${access.data.agentStatus?.replaceAll('_', ' ') ?? 'Not registered'}. An administrator must approve your application.`}
        </p>
        {kind === 'agent' && <Link to="/wallet/agent-setup">Agent application</Link>}
        <Link to="/">Member home</Link>
        <Link to={`/${kind}/login`}>Use another account</Link>
      </div>
    );
  return <>{children}</>;
}
const adminLinks = [
  ['/admin', 'Overview'],
  ['/admin/payments', 'Payment configuration'],
  ['/admin/pricing', 'Rates & packages'],
  ['/admin/disputes', 'Disputes'],
  ['/admin/accounts', 'Accounts'],
  ['/admin/games', 'Game catalog'],
  ['/admin/activity', 'Audit history'],
];
const agentLinks = [
  ['/agent', 'Overview'],
  ['/agent/operations', 'Deposits & payouts'],
  ['/agent/accounts', 'Receiving accounts'],
];
export function WorkspaceLayout({ kind }: { kind: 'admin' | 'agent' }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-shell">
      <a className="workspace-skip" href="#workspace-main">
        Skip to content
      </a>
      <aside className={open ? 'workspace-sidebar open' : 'workspace-sidebar'}>
        <Link className="workspace-brand" to={`/${kind}`}>
          PlayQube<span>{kind === 'admin' ? 'ADMINISTRATION' : 'AGENT WORKSPACE'}</span>
        </Link>
        <nav aria-label={`${kind} navigation`}>
          {(kind === 'admin' ? adminLinks : agentLinks).map(([to, label]) => (
            <NavLink key={to} to={to} end onClick={() => setOpen(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="workspace-identity">
          <strong>{user?.displayName || user?.username}</strong>
          <span>{user?.email}</span>
          <p>{kind === 'admin' ? 'Platform administration' : 'Payment agent'}</p>
          <button onClick={() => void logout()}>Sign out</button>
          <Link to="/">Open member app</Link>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <button className="workspace-menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Close menu' : 'Menu'}
          </button>
          <span>{kind === 'admin' ? 'Control center' : 'Agent services'}</span>
          <span className="workspace-badge">
            {kind === 'admin' ? 'Administrator' : 'Approved agent'}
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
  if (query.isPending)
    return (
      <p role="status" className="workspace-panel">
        Loading current data…
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="workspace-panel">
        Could not load this section. <button onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  return <>{children}</>;
}
export function AdminOverview() {
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
        <p>PLATFORM OVERVIEW</p>
        <h1>Administration dashboard</h1>
        <span>Monitor the platform and manage payment operations in one place.</span>
      </div>
      <QueryState query={query}>
        <div className="workspace-metrics">
          {metrics.map(([key, label]) => (
            <article key={key}>
              <span>{label}</span>
              <strong>{query.data?.[key]}</strong>
            </article>
          ))}
        </div>
        <section className="workspace-panel">
          <h2>Needs attention</h2>
          <div className="workspace-tasks">
            <Link to="/admin/payments">
              <strong>{query.data?.applications}</strong>
              <span>Agent applications</span>
            </Link>
            <Link to="/admin/payments">
              <strong>{query.data?.accounts}</strong>
              <span>Receiving accounts to review</span>
            </Link>
            <Link to="/admin/payments">
              <strong>{query.data?.countries}</strong>
              <span>Countries enabled for payments</span>
            </Link>
          </div>
          <p>
            Country activation alone does not make payments ready. Verified rates, approved accounts
            and backed liquidity are required.
          </p>
        </section>
        <p className="workspace-muted">
          Updated {query.data?.asOf ? new Date(String(query.data.asOf)).toLocaleString() : '—'}
        </p>
      </QueryState>
      <div className="workspace-grid">
        <Link className="workspace-panel workspace-shortcut" to="/admin/payments">
          <h2>Payment operations</h2>
          <p>Countries, methods, agents, receiving accounts and funding.</p>
          <span>Manage payments →</span>
        </Link>
        <Link className="workspace-panel workspace-shortcut" to="/admin/activity">
          <h2>Accountability</h2>
          <p>Review the latest recorded administrative actions.</p>
          <span>Open audit history →</span>
        </Link>
      </div>
      <section className="workspace-panel">
        <h2>Permission boundaries</h2>
        <p>
          Administrators manage configuration and operational reviews. Financial adjustments remain
          restricted to super administrators. Game rules and account roles are not editable in this
          dashboard.
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
        <p>ACCOUNT DIRECTORY</p>
        <h1>Accounts</h1>
        <span>
          Inspect member and staff accounts. Agent approval is managed under Payment configuration.
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
        <label htmlFor="account-search">Username or email</label>
        <input
          id="account-search"
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button>Search</button>
      </form>
      <QueryState query={query}>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Agent profile</th>
                <th>Status</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.username}</strong>
                    <small>{r.email ?? 'No email'}</small>
                  </td>
                  <td>{r.role}</td>
                  <td>{r.agentProfile?.status.replaceAll('_', ' ') ?? '—'}</td>
                  <td>{r.status}</td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!query.data?.rows.length && <p>No matching accounts.</p>}
        </div>
        <div className="workspace-pagination">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} · {query.data?.total} accounts
          </span>
          <button
            disabled={!query.data || page * query.data.pageSize >= query.data.total}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </QueryState>
    </>
  );
}
export function AdminRecords({ kind }: { kind: 'games' | 'audit' }) {
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
        <p>{kind === 'games' ? 'CATALOG OVERSIGHT' : 'ADMINISTRATIVE RECORDS'}</p>
        <h1>{kind === 'games' ? 'Game catalog' : 'Audit history'}</h1>
        <span>
          {kind === 'games'
            ? 'Read-only catalog status. Game availability also depends on runtime admission rules.'
            : 'Latest 100 audit events. Sensitive payloads and credentials are excluded.'}
        </span>
      </div>
      <QueryState query={query}>
        <div className="workspace-table">
          <table>
            <thead>
              <tr>
                {columns.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data?.map((r) => (
                <tr key={String(r.id)}>
                  {columns.map(([key]) => (
                    <td key={key}>
                      {key === 'createdAt'
                        ? new Date(String(r[key])).toLocaleString()
                        : typeof r[key] === 'boolean'
                          ? r[key]
                            ? 'Yes'
                            : 'No'
                          : String(r[key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!query.data?.length && <p>No records to display.</p>}
        </div>
      </QueryState>
    </>
  );
}
export function AgentOverview() {
  const { user } = useAuth();
  return (
    <>
      <div className="workspace-heading">
        <p>YOUR AGENT WORKSPACE</p>
        <h1>Welcome, {user?.displayName || user?.username}</h1>
        <span>Process your assigned payments and maintain your receiving accounts.</span>
      </div>
      <div className="workspace-grid">
        <Link className="workspace-panel workspace-shortcut" to="/agent/operations">
          <h2>Deposits & payouts</h2>
          <p>Review payment evidence, release Coins and record completed transfers.</p>
          <span>Open processing desk →</span>
        </Link>
        <Link className="workspace-panel workspace-shortcut" to="/agent/accounts">
          <h2>Receiving accounts</h2>
          <p>Submit payment destinations for administrator approval.</p>
          <span>Manage your accounts →</span>
        </Link>
      </div>
      <section className="workspace-panel">
        <h2>Your operating scope</h2>
        <p>
          You can process requests assigned to your agent account. Platform configuration, other
          agents’ accounts and administrator decisions remain restricted.
        </p>
      </section>
    </>
  );
}
export function WorkspaceProcessing({ kind }: { kind: 'admin' | 'agent' }) {
  return <WalletOperationsPage workspace={kind} />;
}

export function WorkspaceDestination() {
  const access = useWorkspaceAccess();
  if (access.isPending) return <p role="status">Checking workspace access…</p>;
  if (access.isError)
    return (
      <p role="alert">
        Could not verify access. <button onClick={() => access.refetch()}>Retry</button>
      </p>
    );
  if (access.data.admin) return <Navigate to="/admin" replace />;
  if (access.data.agent) return <Navigate to="/agent" replace />;
  return (
    <section>
      <h1>Staff access required</h1>
      <p>Use your approved agent or administrator account.</p>
      <Link to="/wallet/agent-setup">Apply to become an agent</Link>
    </section>
  );
}
