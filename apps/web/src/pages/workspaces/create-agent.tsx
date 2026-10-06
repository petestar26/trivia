import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';

const requirements =
  '8–72 characters, with uppercase, lowercase, a number and a symbol. Maximum 72 UTF-8 bytes.';
type PendingAgentAccount = {
  userId: string;
  expiresAt: string;
  user: { username: string; email: string };
};
function usePendingAgentAccounts(userId?: string) {
  return useQuery({
    queryKey: ['payments', 'pending-agent-activation', userId],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (requestSignal) =>
            api.get<PendingAgentAccount[]>('/agents/admin/accounts/pending', undefined, {
              signal: requestSignal,
            }),
          signal
        )
      ),
    retry: false,
  });
}
export function CreateAgentPage() {
  const { user } = useAuth();
  const cache = useQueryClient();
  const pending = usePendingAgentAccounts(user?.id);
  const countries = useQuery({
    queryKey: ['payments', 'admin-countries'],
    queryFn: async ({ signal }) =>
      unwrapData(
        await boundedRequest(
          (requestSignal) =>
            api.get<Array<{ id: string; name: string; isActive: boolean }>>(
              '/agent-config/admin/countries',
              undefined,
              { signal: requestSignal }
            ),
          signal
        )
      ),
    retry: false,
  });
  const [form, setForm] = useState({
    username: '',
    email: '',
    displayName: '',
    countryId: '',
    temporaryPassword: '',
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false),
    [checkingPending, setCheckingPending] = useState(false);
  const [result, setResult] = useState<{
    username: string;
    email: string;
    expiresAt: string;
  } | null>(null);
  const active = useRef(false);
  async function refreshPendingAccounts() {
    setCheckingPending(true);
    const refreshed = await pending.refetch();
    setRefreshRequired(!refreshed.isSuccess);
    setError(
      refreshed.isSuccess
        ? 'Could not confirm account creation. Pending accounts have been refreshed below. Check them and the account directory before submitting again; the account may already exist. Usernames and emails must be unique, and the country must be active.'
        : 'Could not confirm account creation or refresh pending accounts. The account may already exist. Refresh pending accounts and check the account directory before submitting again.'
    );
    setCheckingPending(false);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (active.current || refreshRequired || checkingPending) return;
    active.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const body = { ...form };
    // Credentials never enter query keys, query cache, local/session storage or logs.
    setForm((current) => ({ ...current, temporaryPassword: '' }));
    try {
      const value = unwrapData(
        await boundedRequest((signal) =>
          api.post<{ username: string; email: string; expiresAt: string }>(
            '/agents/admin/accounts',
            body,
            undefined,
            { signal }
          )
        )
      );
      setResult(value);
      setForm({
        username: '',
        email: '',
        displayName: '',
        countryId: body.countryId,
        temporaryPassword: '',
      });
      // Background refreshes must not leave a confirmed creation button stuck.
      void cache.invalidateQueries({ queryKey: ['admin-accounts', user?.id] });
      void cache.invalidateQueries({ queryKey: ['admin-overview', user?.id] });
      void cache.invalidateQueries({ queryKey: ['payments'] });
    } catch {
      setRefreshRequired(true);
      setError(
        'Could not confirm account creation. The account may already exist. Checking pending accounts before another submission…'
      );
      await refreshPendingAccounts();
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="workspace-heading">
        <p>AGENT PROVISIONING</p>
        <h1>Create agent account</h1>
        <span>
          Create individual agent accounts directly. Each agent uses a separate email and private
          password.
        </span>
      </div>
      {result && (
        <section className="workspace-panel" role="status">
          <h2>Agent account created</h2>
          <p>
            {result.username} · {result.email}
          </p>
          <p>
            Give the agent their temporary password through your secure channel and direct them to{' '}
            <Link to="/agent/activate">Agent activation</Link>. It expires{' '}
            {new Date(result.expiresAt).toLocaleString()}. The temporary password is not displayed
            or retrievable here.
          </p>
          <p>The form is ready for the next agent. Receiving accounts still require approval.</p>
        </section>
      )}
      <form className="workspace-panel workspace-account-form" onSubmit={submit} autoComplete="off">
        <h2>Account details</h2>
        <label>
          Username
          <input
            required
            minLength={3}
            maxLength={30}
            pattern="[A-Za-z0-9_]+"
            value={form.username}
            disabled={busy}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>
        <label>
          Email
          <input
            required
            type="email"
            maxLength={255}
            value={form.email}
            disabled={busy}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label>
          Display name
          <input
            required
            maxLength={100}
            value={form.displayName}
            disabled={busy}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label>
          Country
          <select
            required
            value={form.countryId}
            disabled={busy || countries.isPending}
            onChange={(e) => setForm({ ...form, countryId: e.target.value })}
          >
            <option value="">Choose an active country</option>
            {countries.data
              ?.filter((c) => c.isActive)
              .map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        {countries.isError && (
          <p role="alert">
            Countries could not load.{' '}
            <button type="button" onClick={() => countries.refetch()}>
              Retry
            </button>
          </p>
        )}
        <label>
          Temporary password
          <input
            required
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={72}
            value={form.temporaryPassword}
            disabled={busy}
            onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })}
          />
        </label>
        <p>{requirements}</p>
        <p>
          The account cannot sign in until the agent sets a new password. No funds or receiving
          accounts are added. Share credentials privately; do not put them in chat messages or
          notes.
        </p>
        {error && (
          <p role="alert">
            {error} <Link to="/admin/accounts">Check accounts</Link>
            {refreshRequired && (
              <button
                type="button"
                disabled={busy || checkingPending}
                onClick={() => void refreshPendingAccounts()}
              >
                Refresh pending accounts
              </button>
            )}
          </p>
        )}
        <button
          disabled={
            busy ||
            refreshRequired ||
            checkingPending ||
            countries.isError ||
            !countries.data?.some((c) => c.isActive)
          }
        >
          {checkingPending
            ? 'Checking pending accounts…'
            : busy
              ? 'Creating account…'
              : 'Create agent account'}
        </button>
      </form>
      <PendingAgentAccounts pending={pending} />
    </>
  );
}
export function ActivateAgentPage() {
  const [form, setForm] = useState({
    email: '',
    temporaryPassword: '',
    newPassword: '',
    confirm: '',
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [done, setDone] = useState(false);
  const active = useRef(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (active.current) return;
    if (form.newPassword !== form.confirm) {
      setMessage('New passwords must match.');
      return;
    }
    if (form.newPassword === form.temporaryPassword) {
      setMessage('Choose a different password from your temporary password.');
      return;
    }
    active.current = true;
    setBusy(true);
    setMessage('');
    const body = {
      email: form.email,
      temporaryPassword: form.temporaryPassword,
      newPassword: form.newPassword,
    };
    setForm((current) => ({ ...current, temporaryPassword: '', newPassword: '', confirm: '' }));
    try {
      // Activation does not mint a session; sign-in remains a separate credential operation.
      unwrapData(
        await boundedRequest((signal) =>
          api.post('/agents/activate-account', body, undefined, { signal })
        )
      );
      setDone(true);
    } catch {
      setMessage(
        'Activation could not be confirmed. Your password may already have been set even if the response was lost. Try signing in with your new password before submitting again; otherwise contact your administrator. Temporary credentials may be invalid, expired or already used.'
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="workspace-shell workspace-activation">
      <div className="workspace-heading">
        <p>PLAYQUBE AGENT ACCESS</p>
        <h1>Set your agent password</h1>
        <span>
          Use the account issued by your administrator. Temporary credentials expire after 24 hours
          and can be used once.
        </span>
      </div>
      {done ? (
        <section className="workspace-panel" role="status">
          <h2>Password set successfully</h2>
          <p>Your temporary password no longer works.</p>
          <Link to="/agent/login">Sign in to agent workspace →</Link>
        </section>
      ) : (
        <form className="workspace-panel workspace-account-form" onSubmit={submit}>
          <label>
            Email
            <input
              required
              type="email"
              autoComplete="username"
              value={form.email}
              disabled={busy}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            Temporary password
            <input
              required
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={form.temporaryPassword}
              disabled={busy}
              onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })}
            />
          </label>
          <label>
            New password
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              value={form.newPassword}
              disabled={busy}
              onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            />
          </label>
          <label>
            Confirm new password
            <input
              required
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              disabled={busy}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
          </label>
          <p>{requirements}</p>
          {message && (
            <p role="alert">
              {message}{' '}
              {message.startsWith('Activation could not be confirmed.') && (
                <Link to="/agent/login">Sign in to check activation</Link>
              )}
            </p>
          )}
          <button disabled={busy}>{busy ? 'Setting password…' : 'Set private password'}</button>
        </form>
      )}
      <Link to="/agent/login">Back to agent sign in</Link>
    </div>
  );
}

function PendingAgentAccounts({
  pending,
}: {
  pending: ReturnType<typeof usePendingAgentAccounts>;
}) {
  const [selected, setSelected] = useState(''),
    [password, setPassword] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false),
    [checkingPending, setCheckingPending] = useState(false);
  const active = useRef(false);
  const replacementConfirmed = useRef(false);
  const selectedIsPending = pending.data?.some((account) => account.userId === selected);
  async function refreshPendingAccounts() {
    setCheckingPending(true);
    const refreshed = await pending.refetch();
    setRefreshRequired(!refreshed.isSuccess);
    if (!refreshed.isSuccess) {
      setMessage(
        replacementConfirmed.current
          ? 'Temporary password was replaced, but pending account status could not refresh. Refresh pending accounts before trying another replacement.'
          : 'Could not confirm replacement or refresh account status. The previous temporary password may no longer work. Refresh pending accounts before trying another replacement.'
      );
    } else if (refreshRequired) {
      setMessage(
        replacementConfirmed.current
          ? 'Temporary password was replaced. Pending accounts have been refreshed. The previous temporary password no longer works.'
          : 'Could not confirm replacement. Pending accounts have been refreshed. Check the current account status before trying another replacement. The previous temporary password may no longer work.'
      );
    }
    setCheckingPending(false);
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (
      active.current ||
      refreshRequired ||
      checkingPending ||
      !selectedIsPending ||
      pending.isError
    )
      return;
    active.current = true;
    setBusy(true);
    setMessage('');
    replacementConfirmed.current = false;
    const body = { temporaryPassword: password };
    setPassword('');
    try {
      const value = unwrapData(
        await boundedRequest((signal) =>
          api.post<{ expiresAt: string }>(
            `/agents/admin/accounts/${selected}/reissue`,
            body,
            undefined,
            { signal }
          )
        )
      );
      replacementConfirmed.current = true;
      setMessage(
        `Temporary password replaced. The previous one no longer works. New expiry: ${new Date(value.expiresAt).toLocaleString()}.`
      );
    } catch {
      setRefreshRequired(true);
      setMessage(
        'Could not confirm replacement. The previous temporary password may no longer work. Check the refreshed account status before trying another replacement. Activated accounts cannot be reset here.'
      );
    } finally {
      await refreshPendingAccounts();
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="workspace-panel workspace-account-form" onSubmit={submit}>
      <h2>Pending activations</h2>
      <p>
        Latest 100 pending accounts. Replace an unused or expired temporary password here. Activated
        private passwords cannot be changed here.
      </p>
      {pending.isPending && <p>Loading pending accounts…</p>}
      {pending.isError && (
        <p role="alert">
          Could not load accounts.{' '}
          <button type="button" onClick={() => pending.refetch()}>
            Retry
          </button>
        </p>
      )}
      {pending.data?.length === 0 && <p>No pending activations.</p>}
      <label>
        Pending agent
        <select
          required
          value={selected}
          disabled={busy}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose an account</option>
          {pending.data?.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.user.username} · {a.user.email} · expires {new Date(a.expiresAt).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      <label>
        Replacement temporary password
        <input
          required
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={72}
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <p>{requirements}</p>
      {message && <p role="status">{message}</p>}
      {refreshRequired && (
        <button
          type="button"
          disabled={busy || checkingPending}
          onClick={() => void refreshPendingAccounts()}
        >
          Refresh pending account status
        </button>
      )}
      <button
        disabled={
          busy || refreshRequired || checkingPending || !selectedIsPending || pending.isError
        }
      >
        {checkingPending
          ? 'Checking account status…'
          : busy
            ? 'Replacing…'
            : 'Replace temporary password'}
      </button>
    </form>
  );
}
