import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import { currencyMinorDigits, inputToMinor, formatMinor } from '@/lib/payment-money';
import { ConfirmAction, PaymentCard } from './wallet-payments';

type Country = {
  id: string;
  code: string;
  name: string;
  currencyCode: string;
  isActive: boolean;
  agentPaymentEnabled: boolean;
};
type Method = { id: string; name: string; type: string; isActive: boolean };
type Agent = {
  id: string;
  userId: string;
  displayName: string;
  status: string;
  user: { status: string };
  availableCoins: number;
  inventory: unknown;
  approvedPaymentAccounts: number;
  paymentAccounts: { id: string; status: string; methodDef: { name: string } }[];
  fiatLiquidity: { fiatCurrency: string; availableBalance: string }[];
};
type Setup = {
  country: Country & { paymentMethods: Method[] };
  agents: Agent[];
  rateId: string | null;
  rateStatus: string;
  truncated: boolean;
  admissionNotice: string;
  crypto: { symbol: string; name: string; network: string; reason: string }[];
};
type Review = {
  id: string;
  updatedAt?: string;
  agent: { displayName: string; countryId: string };
  submittedData?: Record<string, unknown>;
  accountDetails?: Record<string, unknown>;
};
type Deposit = {
  id: string;
  orderNumber: string;
  status: string;
  fiatAmount: number;
  fiatCurrency: string;
  coinAmount: number;
  createdAt: string;
  agent: { displayName: string };
};
const get = async <T,>(path: string, signal?: AbortSignal) =>
  unwrapData(
    await boundedRequest(
      (requestSignal) => api.get<T>(path, undefined, { signal: requestSignal }),
      signal
    )
  );
function displayedPaymentAccountVersion(record: Review): string | null {
  if (typeof record.updatedAt !== 'string') return null;
  const timestamp = new Date(record.updatedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== record.updatedAt)
    return null;
  if (
    !record.accountDetails ||
    typeof record.accountDetails !== 'object' ||
    Array.isArray(record.accountDetails) ||
    Object.keys(record.accountDetails).length === 0
  )
    return null;
  return record.updatedAt;
}

export function WalletSetupAdmin() {
  const cache = useQueryClient();
  const countries = useQuery({
    queryKey: ['payments', 'admin-countries'],
    queryFn: ({ signal }) => get<Country[]>('/agent-config/admin/countries', signal),
    retry: false,
  });
  const [countryId, setCountryId] = useState('');
  const setup = useQuery({
    queryKey: ['payments', 'setup', countryId],
    queryFn: ({ signal }) => get<Setup>(`/agent-config/admin/setup/${countryId}`, signal),
    enabled: !!countryId,
    retry: false,
  });
  const applications = useQuery({
    queryKey: ['payments', 'applications'],
    queryFn: ({ signal }) => get<Review[]>('/agents/applications/pending', signal),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ['payments', 'pending-accounts'],
    queryFn: ({ signal }) => get<Review[]>('/agents/payment-accounts/pending', signal),
    retry: false,
  });
  const deposits = useQuery({
    queryKey: ['payments', 'all-deposits'],
    queryFn: ({ signal }) => get<Deposit[]>('/agent-config/admin/deposits', signal),
    retry: false,
  });
  const [newCountry, setNewCountry] = useState({
    code: 'ET',
    name: 'Ethiopia',
    currencyCode: 'ETB',
  });
  const [method, setMethod] = useState({
    name: '',
    type: 'BANK_TRANSFER',
    fields: 'accountName,accountNumber',
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const funding = useWalletAction('funding');
  const [selectedAgent, setSelectedAgent] = useState(''),
    [fundType, setFundType] = useState('inventory'),
    [fundMode, setFundMode] = useState('fund'),
    [amount, setAmount] = useState('');
  async function change(path: string, body: Record<string, unknown>, patch = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      unwrapData(
        await boundedRequest((signal) =>
          patch ? api.patch(path, body, { signal }) : api.post(path, body, undefined, { signal })
        )
      );
      setMessage('Configuration updated.');
    } catch (e) {
      setMessage(`${walletError(e)} Check the refreshed records before retrying.`);
    } finally {
      try {
        await boundedRequest(() => cache.invalidateQueries({ queryKey: ['payments'] }));
      } catch {
        setMessage(
          (current) =>
            `${current} Some records could not refresh. Refresh the reviews before another action.`
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  const c = setup.data?.country;
  const parsedAmount =
    c && fundType === 'liquidity'
      ? inputToMinor(amount.replace(/^-/, ''), currencyMinorDigits(c.currencyCode))
      : /^-?\d+$/.test(amount) &&
          Number.isSafeInteger(Number(amount)) &&
          Math.abs(Number(amount)) <= 1000000000
        ? Math.abs(Number(amount))
        : null;
  const signed = parsedAmount === null ? null : parsedAmount * (amount.startsWith('-') ? -1 : 1);
  const fundsBody =
    c && signed !== null
      ? fundType === 'inventory'
        ? fundMode === 'fund'
          ? { amount: signed }
          : { signedAmount: signed, reason: note }
        : {
            fiatCurrency: c.currencyCode,
            amountMinor: String(signed),
            ...(fundMode === 'adjust' ? { reason: note } : {}),
          }
      : null;
  return (
    <section className="payment-panel" aria-label="Payment administration">
      <h2>Payment setup & oversight</h2>
      <p>
        Configure a country, verified rate and payment methods, approve agents, then record backed
        Coin inventory and fiat liquidity. Existing account and jurisdiction checks still apply.
      </p>
      {message && <p role="status">{message}</p>}
      {funding.message && <p role="status">{funding.message}</p>}
      {funding.pending && (
        <button
          disabled={funding.busy}
          onClick={() => funding.run(funding.pending!.path, funding.pending!.body)}
        >
          Retry saved funding request
        </button>
      )}
      {countries.isPending && <p role="status">Loading countries…</p>}
      {countries.isError && (
        <p role="alert">
          Could not load countries. <button onClick={() => countries.refetch()}>Retry</button>
        </p>
      )}
      <details>
        <summary>Add a country</summary>
        <p>New countries start inactive with payments disabled.</p>
        {(['code', 'name', 'currencyCode'] as const).map((k) => (
          <label key={k}>
            {{ code: 'Country code', name: 'Country name', currencyCode: 'Currency code' }[k]}
            <input
              value={newCountry[k]}
              maxLength={k === 'name' ? 80 : 3}
              disabled={busy}
              onChange={(e) =>
                setNewCountry({
                  ...newCountry,
                  [k]: k === 'name' ? e.target.value : e.target.value.toUpperCase(),
                })
              }
            />
          </label>
        ))}
        <button
          disabled={
            busy ||
            !newCountry.name ||
            newCountry.code.length !== 2 ||
            newCountry.currencyCode.length !== 3
          }
          onClick={() => change('/agent-config/countries', newCountry)}
        >
          Create inactive country
        </button>
      </details>
      <label>
        Manage country
        <select
          value={countryId}
          disabled={busy || funding.blocked}
          onChange={(e) => {
            setCountryId(e.target.value);
            setSelectedAgent('');
            setAmount('');
          }}
        >
          <option value="">Select country</option>
          {countries.data?.map((x) => (
            <option value={x.id} key={x.id}>
              {x.name} · {x.currencyCode}
            </option>
          ))}
        </select>
      </label>
      {setup.isFetching && countryId && <p role="status">Checking setup…</p>}
      {setup.isError && (
        <p role="alert">
          Setup could not load. <button onClick={() => setup.refetch()}>Retry</button>
        </p>
      )}
      {c && (
        <>
          <article className="payment-record">
            <h3>{c.name} setup status</h3>
            <p>
              Country: {c.isActive ? 'Active' : 'Inactive'} · Agent payments:{' '}
              {c.agentPaymentEnabled ? 'Enabled' : 'Paused'}
            </p>
            <p>Rate: {setup.data!.rateStatus}</p>
            <p>Active methods: {c.paymentMethods.filter((m) => m.isActive).length}</p>
            <p>{setup.data!.admissionNotice}</p>
            <div className="payment-actions">
              <ConfirmAction
                label={c.isActive ? 'Deactivate country' : 'Activate country directory'}
                disabled={busy}
                onConfirm={() =>
                  change(`/agent-config/countries/${c.id}`, { isActive: !c.isActive }, true)
                }
              />
              <ConfirmAction
                label={
                  c.agentPaymentEnabled ? 'Pause new agent payments' : 'Enable new agent payments'
                }
                disabled={
                  busy ||
                  (!c.agentPaymentEnabled &&
                    (!c.isActive ||
                      !setup.data!.rateId ||
                      !c.paymentMethods.some((m) => m.isActive)))
                }
                onConfirm={() =>
                  change(
                    `/agent-config/countries/${c.id}`,
                    { agentPaymentEnabled: !c.agentPaymentEnabled },
                    true
                  )
                }
              />
            </div>
          </article>
          <details>
            <summary>Payment methods</summary>
            {c.paymentMethods.map((m) => (
              <p key={m.id}>
                {m.name} · {m.isActive ? 'Active' : 'Inactive'}{' '}
                <ConfirmAction
                  label={`${m.isActive ? 'Pause' : 'Enable'} ${m.name}`}
                  disabled={busy}
                  onConfirm={() =>
                    change(`/agent-config/payment-methods/${m.id}`, { isActive: !m.isActive }, true)
                  }
                />
              </p>
            ))}
            <label>
              Method name
              <input
                value={method.name}
                disabled={busy}
                onChange={(e) => setMethod({ ...method, name: e.target.value })}
              />
            </label>
            <label>
              Method type
              <select
                value={method.type}
                disabled={busy}
                onChange={(e) => setMethod({ ...method, type: e.target.value })}
              >
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="MOBILE_PAYMENT">Mobile payment</option>
              </select>
            </label>
            <label>
              Required account fields (comma-separated)
              <input
                value={method.fields}
                disabled={busy}
                onChange={(e) => setMethod({ ...method, fields: e.target.value })}
              />
            </label>
            <button
              disabled={busy || !method.name.trim()}
              onClick={() =>
                change(`/agent-config/countries/${c.id}/payment-methods`, {
                  name: method.name,
                  type: method.type,
                  requiredFields: method.fields
                    .split(',')
                    .map((f) => f.trim())
                    .filter(Boolean),
                })
              }
            >
              Add inactive method
            </button>
          </details>
          <details>
            <summary>Agents, Coin inventory & fiat liquidity</summary>
            {setup.data!.truncated && (
              <p>Showing the first 100 agents. This is not a complete funding summary.</p>
            )}
            {!setup.data!.agents.length && (
              <p>
                No agents registered for this country. Create an agent from the administrator
                workspace, or review a submitted agent application.
              </p>
            )}
            {setup.data!.agents.map((a) => (
              <article className="payment-record" key={a.id}>
                <h3>{a.displayName}</h3>
                <p>
                  {a.status} · User {a.user.status} · Approved active accounts:{' '}
                  {a.approvedPaymentAccounts}
                </p>
                <p>Available Coin inventory: {a.availableCoins}</p>
                {a.fiatLiquidity.map((l) => (
                  <p key={l.fiatCurrency}>
                    Available fiat: {formatMinor(l.availableBalance, l.fiatCurrency)}
                  </p>
                ))}
                {a.status === 'ACTIVE' && (
                  <ConfirmAction
                    label={`Suspend ${a.displayName}`}
                    disabled={busy || note.trim().length < 5}
                    onConfirm={() => change(`/agents/${a.id}/suspend`, { reason: note })}
                  />
                )}
                {(a.status === 'TEMPORARILY_SUSPENDED' || a.status === 'UNDER_REVIEW') && (
                  <ConfirmAction
                    label={`Reactivate ${a.displayName}`}
                    disabled={busy}
                    onConfirm={() => change(`/agents/${a.id}/reactivate`, {})}
                  />
                )}
                {a.paymentAccounts
                  .filter((p) => p.status === 'APPROVED')
                  .map((p) => (
                    <p key={p.id}>
                      {p.methodDef.name}{' '}
                      <ConfirmAction
                        label="Disable account"
                        disabled={busy}
                        onConfirm={() =>
                          change(`/agents/payment-accounts/${p.id}/admin-disable`, {})
                        }
                      />
                    </p>
                  ))}
              </article>
            ))}
            <p>
              Funding records must represent verified backing. Initial funding is allowed once;
              subsequent adjustments require a super administrator. This form does not transfer bank
              funds.
            </p>
            <label>
              Agent
              <select
                value={selectedAgent}
                disabled={funding.blocked}
                onChange={(e) => setSelectedAgent(e.target.value)}
              >
                <option value="">Select agent</option>
                {setup.data!.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Funding balance
              <select
                value={fundType}
                disabled={funding.blocked}
                onChange={(e) => {
                  setFundType(e.target.value);
                  setAmount('');
                }}
              >
                <option value="inventory">Coin inventory</option>
                <option value="liquidity">Fiat liquidity · {c.currencyCode}</option>
              </select>
            </label>
            <label>
              Operation
              <select
                value={fundMode}
                disabled={funding.blocked}
                onChange={(e) => setFundMode(e.target.value)}
              >
                <option value="fund">Initial allocation</option>
                <option value="adjust">Adjustment · super admin</option>
              </select>
            </label>
            <label>
              Amount ({fundType === 'inventory' ? 'whole Coins' : c.currencyCode})
              <input
                value={amount}
                disabled={funding.blocked}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p>
              Review amount:{' '}
              {signed === null
                ? 'Enter a valid amount'
                : fundType === 'inventory'
                  ? `${signed} Coins`
                  : `${signed} ${c.currencyCode} minor units`}
            </p>
            <ConfirmAction
              label="Confirm backed allocation"
              disabled={
                funding.blocked ||
                !selectedAgent ||
                !fundsBody ||
                !signed ||
                (fundMode === 'fund' && signed < 0) ||
                (fundMode === 'adjust' && note.trim().length < 5)
              }
              onConfirm={() =>
                funding.run(`/agents/${selectedAgent}/${fundType}/${fundMode}`, fundsBody!)
              }
            />
          </details>
        </>
      )}
      <label>
        Review / adjustment reason
        <textarea
          value={note}
          maxLength={500}
          disabled={busy || funding.blocked}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {(
        [
          ['Agent applications', applications, 'applications'],
          ['Payment account approvals', accounts, 'payment-accounts'],
        ] as const
      ).map(([title, q, path]) => (
        <details key={path}>
          <summary>{title}</summary>
          {q.isPending ? (
            <p>Loading…</p>
          ) : q.isError ? (
            <p role="alert">
              Could not load reviews. <button onClick={() => q.refetch()}>Retry</button>
            </p>
          ) : !q.data?.length ? (
            <p>No pending reviews.</p>
          ) : (
            q.data.map((r) => {
              const paymentAccount = path === 'payment-accounts';
              const expectedUpdatedAt = paymentAccount ? displayedPaymentAccountVersion(r) : null;
              const reviewUnavailable = paymentAccount && (!expectedUpdatedAt || q.isFetching);
              const approveBody = paymentAccount ? { expectedUpdatedAt } : { reviewNote: note };
              const rejectBody = {
                reviewNote: note,
                ...(paymentAccount ? { expectedUpdatedAt } : {}),
              };
              return (
                <article
                  className="payment-record"
                  key={
                    paymentAccount ? JSON.stringify([r.id, r.updatedAt, r.accountDetails]) : r.id
                  }
                  aria-label={`${paymentAccount ? 'Payment account' : 'Agent application'} review ${r.id}`}
                >
                  <h3>{r.agent.displayName}</h3>
                  <p>
                    Country:{' '}
                    {countries.data?.find((c) => c.id === r.agent.countryId)?.name ??
                      r.agent.countryId}
                  </p>
                  <pre className="payment-evidence">
                    {JSON.stringify(
                      paymentAccount ? r.accountDetails : (r.submittedData ?? r.accountDetails),
                      null,
                      2
                    )}
                  </pre>
                  {paymentAccount && !expectedUpdatedAt && (
                    <p role="alert">
                      Account details or review version are unavailable. Reload this review before
                      making a decision.
                    </p>
                  )}
                  <ConfirmAction
                    label="Approve verified record"
                    disabled={busy || reviewUnavailable}
                    onConfirm={() => {
                      if (busy || reviewUnavailable) return;
                      void change(`/agents/${path}/${r.id}/approve`, approveBody);
                    }}
                  />
                  <ConfirmAction
                    label="Reject with reason"
                    disabled={busy || reviewUnavailable || note.trim().length < 5}
                    onConfirm={() => {
                      if (busy || reviewUnavailable || note.trim().length < 5) return;
                      void change(`/agents/${path}/${r.id}/reject`, rejectBody);
                    }}
                  />
                </article>
              );
            })
          )}
        </details>
      ))}
      <details>
        <summary>Latest 100 deposit orders</summary>
        {deposits.isPending ? (
          <p>Loading…</p>
        ) : deposits.isError ? (
          <p role="alert">
            Could not load orders. <button onClick={() => deposits.refetch()}>Retry</button>
          </p>
        ) : !deposits.data?.length ? (
          <p>No deposit orders.</p>
        ) : (
          deposits.data.map((d) => (
            <PaymentCard key={d.id} payment={d}>
              <p>Agent: {d.agent.displayName}</p>
            </PaymentCard>
          ))
        )}
      </details>
      <details>
        <summary>Crypto integration status</summary>
        <p>
          USDT, USDC, Bitcoin, Ethereum and Solana are planned options. Your existing provider must
          be identified before network mappings, authenticated payment notifications and settlement
          can be connected. Crypto remains unavailable; there is no manual “mark paid” bypass.
        </p>
        {setup.data?.crypto.map((a) => (
          <p key={a.symbol}>
            {a.name} · {a.symbol} · {a.network} · {a.reason}
          </p>
        ))}
      </details>
    </section>
  );
}
