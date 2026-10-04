import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { walletError } from '@/hooks/use-wallet-action';
import { useAuth } from '@/providers/auth-provider';
import { PaymentNavigation } from './wallet-payments';
import './wallet-payments.css';
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));
type Agent = { id: string; countryId: string; displayName: string; status: string };
type Method = { id: string; name: string; fieldSchema: { requiredFields: string[] } };
export function WalletAgentSetupPage() {
  const { user } = useAuth();
  return user ? <AgentSetup key={user.id} userId={user.id} /> : null;
}
function AgentSetup({ userId }: { userId: string }) {
  const cache = useQueryClient();
  const agent = useQuery({
    queryKey: ['payments', 'own-agent', userId],
    queryFn: () => get<Agent | null>('/agents/me/setup'),
  });
  const countries = useQuery({
    queryKey: ['payments', 'active-countries', userId],
    queryFn: () => get<{ id: string; name: string }[]>('/agent-config/countries'),
  });
  const accounts = useQuery({
    queryKey: ['payments', 'own-payment-accounts', userId],
    queryFn: () =>
      get<{ id: string; status: string; methodDefId: string }[]>('/agents/me/payment-accounts'),
    enabled: !!agent.data,
  });
  const methods = useQuery({
    queryKey: ['payments', 'agent-methods', agent.data?.countryId, userId],
    queryFn: () =>
      get<Method[]>(`/agent-config/countries/${agent.data!.countryId}/payment-methods/active`),
    enabled: !!agent.data,
  });
  const [application, setApplication] = useState({
    countryId: '',
    displayName: '',
    contactEmail: '',
    contactPhone: '',
  });
  const [methodId, setMethod] = useState(''),
    [details, setDetails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const active = useRef(false);
  const method = methods.data?.find((m) => m.id === methodId);
  async function submit(path: string, body: Record<string, unknown>) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    try {
      await boundedRequest((signal) => api.post(path, body, undefined, { signal }));
      setMessage('Submitted for administrator review.');
      setDetails({});
      setMethod('');
    } catch (e) {
      setMessage(`${walletError(e)} Check your refreshed application/accounts before retrying.`);
    } finally {
      await cache.invalidateQueries({ queryKey: ['payments'] });
      setBusy(false);
      active.current = false;
    }
  }
  return (
    <div className="payments-page">
      <h1>Payment agent setup</h1>
      <PaymentNavigation />
      <section className="payment-panel">
        <p>
          Apply to serve a country and submit your payment destination for review. Approval,
          verified backing and available liquidity are required before processing customer payments.
        </p>
        {message && <p role="status">{message}</p>}
        {agent.isPending ? (
          <p role="status">Checking application…</p>
        ) : agent.isError ? (
          <p role="alert">
            Could not check your agent status.{' '}
            <button onClick={() => agent.refetch()}>Retry</button>
          </p>
        ) : agent.data ? (
          <>
            <h2>{agent.data.displayName}</h2>
            <p>Status: {agent.data.status}</p>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit('/agents/applications', application);
            }}
          >
            {countries.isError && (
              <p role="alert">
                Countries could not load.{' '}
                <button type="button" onClick={() => countries.refetch()}>
                  Retry
                </button>
              </p>
            )}
            <label>
              Agent country
              <select
                required
                disabled={busy || countries.isPending}
                value={application.countryId}
                onChange={(e) => setApplication({ ...application, countryId: e.target.value })}
              >
                <option value="">Choose country</option>
                {countries.data?.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {countries.data?.length === 0 && (
              <p>The administrator must activate a country before applications can be submitted.</p>
            )}
            {(['displayName', 'contactEmail', 'contactPhone'] as const).map((k) => (
              <label key={k}>
                {
                  {
                    displayName: 'Agent display name',
                    contactEmail: 'Contact email',
                    contactPhone: 'Contact phone (optional)',
                  }[k]
                }
                <input
                  required={k !== 'contactPhone'}
                  type={k === 'contactEmail' ? 'email' : 'text'}
                  maxLength={k === 'contactPhone' ? 40 : 160}
                  disabled={busy}
                  value={application[k]}
                  onChange={(e) => setApplication({ ...application, [k]: e.target.value })}
                />
              </label>
            ))}
            <button
              disabled={
                busy ||
                !application.countryId ||
                !application.displayName.trim() ||
                !application.contactEmail
              }
            >
              Submit agent application
            </button>
          </form>
        )}
      </section>
      {agent.data && (
        <section className="payment-panel">
          <h2>Payment accounts</h2>
          {accounts.isPending ? (
            <p>Loading accounts…</p>
          ) : accounts.isError ? (
            <p role="alert">
              Could not load accounts. <button onClick={() => accounts.refetch()}>Retry</button>
            </p>
          ) : accounts.data?.length ? (
            accounts.data.map((a) => (
              <p key={a.id}>
                {methods.data?.find((m) => m.id === a.methodDefId)?.name ?? a.methodDefId} ·{' '}
                {a.status}
              </p>
            ))
          ) : (
            <p>No payment accounts submitted.</p>
          )}
          {['PENDING_VERIFICATION', 'ACTIVE'].includes(agent.data.status) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit('/agents/me/payment-accounts', {
                  countryId: agent.data!.countryId,
                  methodDefId: methodId,
                  accountDetails: details,
                });
              }}
            >
              {methods.isError && (
                <p role="alert">
                  Methods could not load.{' '}
                  <button type="button" onClick={() => methods.refetch()}>
                    Retry
                  </button>
                </p>
              )}
              <label>
                Account payment method
                <select
                  value={methodId}
                  required
                  disabled={busy || methods.isPending}
                  onChange={(e) => {
                    setMethod(e.target.value);
                    setDetails({});
                  }}
                >
                  <option value="">Choose method</option>
                  {methods.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {methods.data?.length === 0 && (
                <p>No active payment methods configured for your country.</p>
              )}
              {method?.fieldSchema.requiredFields.map((field) => (
                <label key={field}>
                  {field}
                  <input
                    required
                    maxLength={500}
                    disabled={busy}
                    value={details[field] ?? ''}
                    onChange={(e) => setDetails({ ...details, [field]: e.target.value })}
                  />
                </label>
              ))}
              <p>
                Submit only the required receiving-account details. Never enter passwords, PINs or
                recovery phrases.
              </p>
              <button
                disabled={
                  busy ||
                  !method ||
                  method.fieldSchema.requiredFields.some((f) => !details[f]?.trim())
                }
              >
                Submit account for review
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
