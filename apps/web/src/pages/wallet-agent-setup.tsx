import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { walletError } from '@/hooks/use-wallet-action';
import { useAuth } from '@/providers/auth-provider';
import { PaymentNavigation } from './wallet-payments';
import './wallet-payments.css';
const get = async <T,>(path: string, signal?: AbortSignal) =>
  unwrapData(
    await boundedRequest(
      (requestSignal) => api.get<T>(path, undefined, { signal: requestSignal }),
      signal
    )
  );
type Agent = { id: string; countryId: string; displayName: string; status: string };
type Method = { id: string; name: string; fieldSchema: { requiredFields: string[] } };
type Account = {
  id: string;
  countryId: string;
  status: string;
  methodDefId: string;
  accountDetails: Record<string, unknown>;
  updatedAt?: string;
};
const editableStates = ['APPROVED', 'PENDING_APPROVAL', 'REJECTED'];
const disableableStates = ['APPROVED', 'PENDING_APPROVAL'];
const validEditVersion = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const fieldLabel = (field: string) => {
  const known: Record<string, string> = {
    accountName: 'Account name',
    accountNumber: 'Account number',
    phoneNumber: 'Phone number',
    mobileNumber: 'Mobile number',
    iban: 'IBAN',
    swiftCode: 'SWIFT code',
  };
  if (known[field]) return known[field];
  const text = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const accountVersion = (account: Account) =>
  JSON.stringify([
    account.id,
    account.countryId,
    account.status,
    account.methodDefId,
    account.updatedAt,
    account.accountDetails,
  ]);
export function WalletAgentSetupPage({ workspace = false }: { workspace?: boolean }) {
  const { user } = useAuth();
  return user ? <AgentSetup key={user.id} userId={user.id} workspace={workspace} /> : null;
}
function AgentSetup({ userId, workspace }: { userId: string; workspace: boolean }) {
  const cache = useQueryClient();
  const agent = useQuery({
    queryKey: ['payments', 'own-agent', userId],
    queryFn: async ({ signal }) => {
      const response = await boundedRequest(
        (requestSignal) =>
          api.get<Agent | null>('/agents/me/setup', undefined, { signal: requestSignal }),
        signal
      );
      // This endpoint explicitly returns null for a user with no agent profile.
      // Missing data and failed responses must still fail closed.
      if (response.success && response.data === null) return null;
      return unwrapData(response);
    },
    retry: false,
  });
  const countries = useQuery({
    queryKey: ['payments', 'active-countries', userId],
    queryFn: ({ signal }) => get<{ id: string; name: string }[]>('/agent-config/countries', signal),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['payments', 'own-payment-accounts', userId],
    queryFn: ({ signal }) => get<Account[]>('/agents/me/payment-accounts', signal),
    enabled: !!agent.data,
    retry: false,
  });
  const methods = useQuery({
    queryKey: ['payments', 'agent-methods', agent.data?.countryId, userId],
    queryFn: ({ signal }) =>
      get<Method[]>(
        `/agent-config/countries/${agent.data!.countryId}/payment-methods/active`,
        signal
      ),
    enabled: !!agent.data,
    retry: false,
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
  const [messageIsError, setMessageIsError] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    version: string;
    expectedUpdatedAt: string;
  } | null>(null);
  const [disabling, setDisabling] = useState('');
  const active = useRef(false);
  const method = methods.data?.find((m) => m.id === methodId);
  const canManage =
    !agent.isError &&
    !!agent.data &&
    ['PENDING_VERIFICATION', 'ACTIVE'].includes(agent.data.status);
  const accountsVerified =
    agent.isSuccess &&
    !!agent.data &&
    accounts.isSuccess &&
    methods.isSuccess &&
    !agent.isFetching &&
    !accounts.isFetching &&
    !methods.isFetching;
  const accountsReady = canManage && accountsVerified;
  const editedAccount = editing ? accounts.data?.find((a) => a.id === editing.id) : null;
  const validDraft =
    accountsReady &&
    !!method &&
    (!editing ||
      (!!editedAccount &&
        editableStates.includes(editedAccount.status) &&
        validEditVersion(editedAccount.updatedAt) &&
        accountVersion(editedAccount) === editing.version)) &&
    method.fieldSchema.requiredFields.every((field) => !!details[field]?.trim());
  function resetAccountForm() {
    setEditing(null);
    setDisabling('');
    setDetails({});
    setMethod('');
  }
  useEffect(() => {
    if (
      editing &&
      !accounts.isFetching &&
      accounts.isSuccess &&
      (!canManage || !editedAccount || accountVersion(editedAccount) !== editing.version)
    ) {
      resetAccountForm();
      setMessageIsError(true);
      setMessage(
        'This account changed while you were editing. Review the refreshed account before editing again.'
      );
    }
  }, [editing, accounts.isFetching, accounts.isSuccess, editedAccount, canManage]);
  async function submit(
    path: string,
    body: Record<string, unknown> | undefined,
    patch = false,
    successMessage = 'Submitted for administrator review.'
  ) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      unwrapData(
        await boundedRequest((signal) =>
          patch ? api.patch(path, body, { signal }) : api.post(path, body, undefined, { signal })
        )
      );
      setMessage(successMessage);
    } catch (e) {
      setMessageIsError(true);
      setMessage(
        `${walletError(e)} Check your refreshed application/accounts before submitting again. A request may have completed even if its response was lost.`
      );
    } finally {
      resetAccountForm();
      await cache.invalidateQueries({ queryKey: ['payments'], refetchType: 'none' });
      await Promise.all([
        agent.refetch(),
        ...(agent.data ? [accounts.refetch(), methods.refetch()] : []),
      ]);
      setBusy(false);
      active.current = false;
    }
  }
  function editAccount(account: Account) {
    if (
      !accountsReady ||
      busy ||
      !editableStates.includes(account.status) ||
      !validEditVersion(account.updatedAt) ||
      account.countryId !== agent.data?.countryId
    )
      return;
    const currentMethod = methods.data?.find((m) => m.id === account.methodDefId);
    setEditing({
      id: account.id,
      version: accountVersion(account),
      expectedUpdatedAt: account.updatedAt,
    });
    setDisabling('');
    setMethod(currentMethod?.id ?? '');
    setDetails(
      Object.fromEntries(
        (currentMethod?.fieldSchema.requiredFields ?? []).map((field) => [
          field,
          typeof account.accountDetails[field] === 'string'
            ? (account.accountDetails[field] as string)
            : '',
        ])
      )
    );
    setMessage('');
    setMessageIsError(false);
  }
  return (
    <div className="payments-page">
      <h1>Payment agent setup</h1>
      {!workspace && <PaymentNavigation />}
      <section className="payment-panel">
        <p>
          Apply to serve a country and submit your payment destination for review. Approval,
          verified backing and available liquidity are required before processing customer payments.
        </p>
        {message && <p role={messageIsError ? 'alert' : 'status'}>{message}</p>}
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
            <p>Status: {fieldLabel(agent.data.status.toLowerCase())}</p>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                busy ||
                countries.isError ||
                countries.isFetching ||
                !countries.data?.some((c) => c.id === application.countryId) ||
                !application.displayName.trim() ||
                !application.contactEmail.trim()
              )
                return;
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
                disabled={busy || countries.isPending || countries.isError}
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
                countries.isError ||
                countries.isFetching ||
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
            <p role="status">Loading accounts…</p>
          ) : accounts.isError ? (
            <p role="alert">
              Could not load accounts. <button onClick={() => accounts.refetch()}>Retry</button>
            </p>
          ) : accounts.data?.length ? (
            accounts.data.map((a) => (
              <article
                className="payment-record"
                key={a.id}
                aria-label={`Receiving account ${a.id}`}
              >
                <div>
                  <h3>
                    {methods.data?.find((m) => m.id === a.methodDefId)?.name ?? 'Receiving account'}
                  </h3>
                  <span className="payment-status">{fieldLabel(a.status.toLowerCase())}</span>
                </div>
                <p>Reference: {a.id}</p>
                <dl>
                  {Object.entries(a.accountDetails ?? {}).map(([field, value]) => (
                    <div key={field}>
                      <dt>{fieldLabel(field)}</dt>
                      <dd>{typeof value === 'string' ? value : 'Detail unavailable'}</dd>
                    </div>
                  ))}
                </dl>
                {a.status === 'REJECTED' && (
                  <p>
                    This account was not approved. Check the administrator’s feedback, correct the
                    details and resubmit for review.
                  </p>
                )}
                {a.status === 'PENDING_APPROVAL' && (
                  <p>
                    Awaiting administrator review. This destination cannot receive new customer
                    orders until approved.
                  </p>
                )}
                {a.status === 'DISABLED' && (
                  <p>This account is disabled. Its history is preserved.</p>
                )}
                <div className="payment-actions">
                  {editableStates.includes(a.status) && a.countryId === agent.data!.countryId && (
                    <button
                      type="button"
                      disabled={busy || !accountsReady || !validEditVersion(a.updatedAt)}
                      onClick={() => editAccount(a)}
                    >
                      {a.status === 'REJECTED' ? 'Correct and resubmit' : 'Edit account'}
                    </button>
                  )}
                  {disableableStates.includes(a.status) && (
                    <button
                      type="button"
                      disabled={busy || !accountsVerified}
                      onClick={() => {
                        if (!accountsVerified || busy) return;
                        resetAccountForm();
                        setDisabling(a.id);
                      }}
                    >
                      Disable account
                    </button>
                  )}
                </div>
                {disabling === a.id && disableableStates.includes(a.status) && (
                  <div
                    role="group"
                    aria-label="Confirm account disabling"
                    className="payment-disclosure"
                  >
                    <p>
                      Disable this receiving account? It will be unavailable for new customer
                      orders. History is preserved, and it cannot be re-enabled from this page.
                    </p>
                    <div className="payment-actions">
                      <button
                        type="button"
                        disabled={busy || !accountsVerified}
                        onClick={() => {
                          if (!accountsVerified || busy || !disableableStates.includes(a.status))
                            return;
                          void submit(
                            `/agents/me/payment-accounts/${a.id}/disable`,
                            undefined,
                            false,
                            'Receiving account disabled. Its history has been preserved.'
                          );
                        }}
                      >
                        Confirm disable
                      </button>
                      <button type="button" disabled={busy} onClick={() => setDisabling('')}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))
          ) : (
            <p>No payment accounts submitted.</p>
          )}
          {accounts.isFetching && !accounts.isPending && <p role="status">Refreshing accounts…</p>}
          {methods.isPending && <p role="status">Loading payment methods…</p>}
          {methods.isError && (
            <p role="alert">
              Methods could not load.{' '}
              <button type="button" onClick={() => methods.refetch()}>
                Retry
              </button>
            </p>
          )}
          {canManage && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || !validDraft) return;
                void submit(
                  editing
                    ? `/agents/me/payment-accounts/${editing.id}`
                    : '/agents/me/payment-accounts',
                  {
                    countryId: agent.data!.countryId,
                    methodDefId: methodId,
                    ...(editing ? { expectedUpdatedAt: editing.expectedUpdatedAt } : {}),
                    accountDetails: Object.fromEntries(
                      method!.fieldSchema.requiredFields.map((field) => [
                        field,
                        details[field].trim(),
                      ])
                    ),
                  },
                  !!editing,
                  editing
                    ? 'Updated account submitted for administrator review. Approval is required before it can receive new orders.'
                    : 'Receiving account submitted for administrator review.'
                );
              }}
            >
              <h3>{editing ? 'Edit receiving account' : 'Add receiving account'}</h3>
              {editing && (
                <p className="payment-disclosure">
                  Saving changes sends this account back for administrator review. It cannot receive
                  new customer orders until approved again.
                </p>
              )}
              <label>
                Account payment method
                <select
                  value={methodId}
                  required
                  disabled={busy || !accountsReady}
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
                  {fieldLabel(field)}
                  <input
                    required
                    maxLength={500}
                    disabled={busy || !accountsReady}
                    value={details[field] ?? ''}
                    onChange={(e) => setDetails({ ...details, [field]: e.target.value })}
                  />
                </label>
              ))}
              <p>
                Submit only the required receiving-account details. Never enter passwords, PINs or
                recovery phrases.
              </p>
              <button disabled={busy || !validDraft}>
                {busy
                  ? 'Updating accounts…'
                  : editing
                    ? 'Save and resubmit for review'
                    : 'Submit account for review'}
              </button>
              {editing && (
                <button type="button" disabled={busy} onClick={resetAccountForm}>
                  Cancel editing
                </button>
              )}
            </form>
          )}
        </section>
      )}
    </div>
  );
}
