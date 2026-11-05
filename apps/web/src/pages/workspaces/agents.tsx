import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { formatEtb } from '@/lib/payment-money';
import { getErrorMessage, getErrorStatus } from '@/lib/error-message';
import { staffLabel } from './agent-overview';
type Agent = {
  id: string;
  displayName: string;
  status: string;
  updatedAt: string;
  availableDepositFunding: number;
  user: { id: string; username: string; email: string | null; status: string };
  country: { name: string };
  _count: { paymentAccounts: number; orders: number; withdrawals: number };
};
const actions: Record<string, Array<[string, string]>> = {
  ACTIVE: [
    ['suspend', 'Pause agent'],
    ['under-review', 'Place under review'],
    ['disable', 'Disable agent'],
  ],
  TEMPORARILY_SUSPENDED: [
    ['reactivate', 'Reactivate agent'],
    ['disable', 'Disable agent'],
  ],
  UNDER_REVIEW: [
    ['reactivate', 'Reactivate agent'],
    ['suspend', 'Pause agent'],
    ['disable', 'Disable agent'],
  ],
};
export function AdminAgents() {
  const { user } = useAuth();
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || ''),
    [q, setQ] = useState(params.get('q') || '');
  const [page, setPage] = useState(1),
    [status, setStatus] = useState('');
  const [selection, setSelection] = useState<{ id: string; action: string; label: string } | null>(
    null
  );
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const active = useRef(false);
  const query = useQuery({
    queryKey: ['admin-agents', user?.id, page, q, status],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (s) =>
            api.get<{ rows: Agent[]; total: number; pageSize: number }>(
              `/workspaces/admin/agents?page=${page}&q=${encodeURIComponent(q)}${status ? '&status=' + status : ''}`,
              undefined,
              { signal: s }
            ),
          signal
        )
      ),
    retry: false,
  });
  const selected = query.data?.rows.find((a) => a.id === selection?.id);
  useEffect(() => {
    setConfirmed(false);
  }, [selected?.updatedAt]);
  async function change(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || !selected || !selection || !confirmed || reason.trim().length < 5) return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      unwrapData(
        await boundedRequest((signal) =>
          api.post(
            `/agents/${selected.id}/${selection.action}`,
            { reason: reason.trim(), expectedUpdatedAt: selected.updatedAt },
            undefined,
            { signal }
          )
        )
      );
      setNotice(`${selected.displayName}: agent status updated.`);
      setSelection(null);
      setReason('');
      for (const queryKey of [
        ['admin-agents'],
        ['admin-account-detail'],
        ['admin-overview'],
        ['payments'],
      ])
        void cache.invalidateQueries({ queryKey });
    } catch (error) {
      const code = getErrorStatus(error);
      setNotice(
        code && code >= 400 && code < 500
          ? getErrorMessage(error, 'Agent status could not be changed.')
          : 'The update could not be confirmed. Review the refreshed status before trying again.'
      );
      await query.refetch();
    } finally {
      setConfirmed(false);
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <header className="workspace-heading">
        <p>AGENT MANAGEMENT</p>
        <h1>Agents</h1>
        <span>Review agent access, operating status and account history.</span>
        <Link to="/admin/agents/new">Add an agent →</Link>
      </header>
      <form
        className="workspace-search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(search.trim());
          setSelection(null);
        }}
      >
        <label htmlFor="agent-search">Name, username or email</label>
        <input
          id="agent-search"
          maxLength={100}
          value={search}
          disabled={busy}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label htmlFor="agent-status">Status</label>
        <select
          id="agent-status"
          value={status}
          disabled={busy}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
            setSelection(null);
          }}
        >
          <option value="">All statuses</option>
          {[
            'ACTIVE',
            'PENDING_VERIFICATION',
            'TEMPORARILY_SUSPENDED',
            'UNDER_REVIEW',
            'DISABLED',
          ].map((s) => (
            <option key={s} value={s}>
              {staffLabel(s)}
            </option>
          ))}
        </select>
        <button disabled={busy}>Search agents</button>
      </form>
      {notice && (
        <p role="status" className="workspace-panel">
          {notice}
        </p>
      )}
      {query.isPending ? (
        <p role="status">Loading agents…</p>
      ) : query.isError ? (
        <p role="alert">
          Agents could not load. <button onClick={() => query.refetch()}>Retry</button>
        </p>
      ) : (
        <>
          <div className="workspace-table">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Country</th>
                  <th>Status</th>
                  <th>Available deposit funding</th>
                  <th>Operations</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/admin/accounts/${a.user.id}`}>
                        <strong>{a.displayName}</strong>
                      </Link>
                      <small>{a.user.email || a.user.username}</small>
                    </td>
                    <td>{a.country.name}</td>
                    <td>
                      {staffLabel(a.status)}
                      <small>Member: {staffLabel(a.user.status)}</small>
                    </td>
                    <td>
                      {formatEtb(a.availableDepositFunding)}
                      <small>{a._count.paymentAccounts} receiving accounts</small>
                    </td>
                    <td>
                      <Link to={`/admin/accounts/${a.user.id}`}>Account details</Link>
                      {a.user.id !== user?.id &&
                        (actions[a.status] ?? []).map(([action, label]) => (
                          <button
                            key={action}
                            disabled={busy}
                            onClick={() => {
                              setSelection({ id: a.id, action, label });
                              setReason('');
                              setConfirmed(false);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      {a.status === 'PENDING_VERIFICATION' && (
                        <Link to="/admin/payments">Review application</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!query.data.rows.length && <p>No matching agents.</p>}
          </div>
          <div className="workspace-pagination">
            <button
              disabled={busy || page === 1}
              onClick={() => {
                setPage(page - 1);
                setSelection(null);
              }}
            >
              Previous
            </button>
            <span>
              Page {page} · {query.data.total} agents
            </span>
            <button
              disabled={busy || page * query.data.pageSize >= query.data.total}
              onClick={() => {
                setPage(page + 1);
                setSelection(null);
              }}
            >
              Next
            </button>
          </div>
        </>
      )}
      {selected && selection && (
        <form className="workspace-panel workspace-account-form" onSubmit={change}>
          <h2>
            {selection.label}: {selected.displayName}
          </h2>
          <p>
            Current status: {staffLabel(selected.status)}. The member login and financial history
            are preserved.
          </p>
          {selection.action === 'disable' && (
            <p>Disabling ends this agent profile permanently. It cannot be reactivated.</p>
          )}
          <label>
            Reason
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
            I reviewed this agent and the requested status change.
          </label>
          <button disabled={busy || !confirmed || query.isFetching || reason.trim().length < 5}>
            {busy ? 'Updating agent…' : `Confirm ${selection.label.toLowerCase()}`}
          </button>
          <button type="button" disabled={busy} onClick={() => setSelection(null)}>
            Cancel
          </button>
        </form>
      )}
      <p className="workspace-muted">
        Receiving accounts, verified backing and payout liquidity are managed in{' '}
        <Link to="/admin/payments">Payment configuration</Link>.
      </p>
    </>
  );
}
