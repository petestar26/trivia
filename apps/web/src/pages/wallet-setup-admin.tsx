import { formatEtb } from '@/lib/payment-money';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import { currencyMinorDigits, inputToMinor, formatMinor } from '@/lib/payment-money';
import { ConfirmAction, PaymentCard } from './wallet-payments';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  paymentAccounts: { id: string; status: string; safetyHold?: boolean; updatedAt?: string; methodDef: { name: string } }[];
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
  countryId?: string;
  country?: { name: string };
  methodDef?: { name: string; type: string };
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
  const { t: translateUi } = useInterfaceLanguage();

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
  const [actionNotes, setActionNotes] = useState<Record<string, string>>({});
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
  const parsedAmount = inputToMinor(
    amount.replace(/^-/, ''),
    c && fundType === 'liquidity' ? currencyMinorDigits(c.currencyCode) : 2
  );
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
    <section className="payment-panel" aria-label={translateUi('Payment administration')}>
      <h1>{translateUi('Payment setup & oversight')}</h1>
      <p>
        {translateUi(
          'Configure a country, verified rate and payment methods, approve agents, then record backed ETB deposit funding and fiat liquidity. Existing account and jurisdiction checks still apply.'
        )}
      </p>
      {message && <p role="status">{translateUi(message)}</p>}
      {funding.message && <p role="status">{funding.message}</p>}
      {funding.pending && (
        <button
          disabled={funding.busy}
          onClick={() => funding.run(funding.pending!.path, funding.pending!.body)}
        >
          {translateUi('Retry saved funding request')}
        </button>
      )}
      {countries.isPending && <p role="status">{translateUi('Loading countries…')}</p>}
      {countries.isError && (
        <p role="alert">
          {translateUi('Could not load countries.') + ' '}
          <button onClick={() => countries.refetch()}>{translateUi('Retry')}</button>
        </p>
      )}
      <details>
        <summary>{translateUi('Add a country')}</summary>
        <p>{translateUi('New countries start inactive with payments disabled.')}</p>
        {(['code', 'name', 'currencyCode'] as const).map((k) => (
          <label key={k}>
            {translateUi(
              { code: 'Country code', name: 'Country name', currencyCode: 'Currency code' }[k]
            )}
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
          {translateUi('Create inactive country')}
        </button>
      </details>
      <label>
        {translateUi('Manage country')}
        <select
          value={countryId}
          disabled={busy || funding.blocked}
          onChange={(e) => {
            setCountryId(e.target.value);
            setSelectedAgent('');
            setAmount('');
          }}
        >
          <option value="">{translateUi('Select country')}</option>
          {countries.data?.map((x) => (
            <option value={x.id} key={x.id}>
              {x.name} · {x.currencyCode}
            </option>
          ))}
        </select>
      </label>
      {setup.isFetching && countryId && <p role="status">{translateUi('Checking setup…')}</p>}
      {setup.isError && (
        <p role="alert">
          {translateUi('Setup could not load.') + ' '}
          <button onClick={() => setup.refetch()}>{translateUi('Retry')}</button>
        </p>
      )}
      {c && (
        <>
          <article className="payment-record">
            <h3>{translateUi('{name} setup status', { name: c.name })}</h3>
            <p>
              {translateUi('Country: {value} · Agent payments: {value2}', {
                value: c.isActive ? translateUi('Active') : translateUi('Inactive'),
                value2: c.agentPaymentEnabled ? translateUi('Enabled') : translateUi('Paused'),
              })}
            </p>
            <p>{translateUi('Rate: {rateStatus}', { rateStatus: setup.data!.rateStatus })}</p>
            <p>
              {translateUi('Active methods: {length}', {
                length: c.paymentMethods.filter((m) => m.isActive).length,
              })}
            </p>
            <p>{setup.data!.admissionNotice}</p>
            <div className="payment-actions">
              <ConfirmAction
                label={
                  c.isActive
                    ? translateUi('Deactivate country')
                    : translateUi('Activate country directory')
                }
                disabled={busy}
                onConfirm={() =>
                  change(`/agent-config/countries/${c.id}`, { isActive: !c.isActive }, true)
                }
              />
              <ConfirmAction
                label={
                  c.agentPaymentEnabled
                    ? translateUi('Pause new agent payments')
                    : translateUi('Enable new agent payments')
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
            <summary>{translateUi('Payment methods')}</summary>
            {c.paymentMethods.map((m) => (
              <p key={m.id}>
                {m.name} · {m.isActive ? translateUi('Active') : translateUi('Inactive')}{' '}
                <ConfirmAction
                  label={translateUi(m.isActive ? 'Pause {name}' : 'Enable {name}', {
                    name: m.name,
                  })}
                  disabled={busy}
                  onConfirm={() =>
                    change(`/agent-config/payment-methods/${m.id}`, { isActive: !m.isActive }, true)
                  }
                />
              </p>
            ))}
            <label>
              {translateUi('Method name')}
              <input
                value={method.name}
                disabled={busy}
                onChange={(e) => setMethod({ ...method, name: e.target.value })}
              />
            </label>
            <label>
              {translateUi('Method type')}
              <select
                value={method.type}
                disabled={busy}
                onChange={(e) => setMethod({ ...method, type: e.target.value })}
              >
                <option value="BANK_TRANSFER">{translateUi('Bank transfer')}</option>
                <option value="MOBILE_PAYMENT">{translateUi('Mobile payment')}</option>
              </select>
            </label>
            <label>
              {translateUi('Required account fields (comma-separated)')}
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
              {translateUi('Add inactive method')}
            </button>
          </details>
          <details>
            <summary>{translateUi('Agents, ETB deposit funding & fiat liquidity')}</summary>
            {setup.data!.truncated && (
              <p>
                {translateUi(
                  'Showing the first 100 agents. This is not a complete funding summary.'
                )}
              </p>
            )}
            {!setup.data!.agents.length && (
              <p>
                {translateUi(
                  'No agents registered for this country. Create an agent from the administrator workspace, or review a submitted agent application.'
                )}
              </p>
            )}
            {setup.data!.agents.map((a) => (
              <article className="payment-record" key={a.id}>
                <h3>{a.displayName}</h3>
                <p>
                  {translateUi(
                    '{status} · User {status2} · Approved active accounts: {approvedPaymentAccounts}',
                    {
                      status: a.status,
                      status2: a.user.status,
                      approvedPaymentAccounts: a.approvedPaymentAccounts,
                    }
                  )}
                </p>
                <p>
                  {translateUi('Available deposit funding: {value}', {
                    value: formatEtb(a.availableCoins),
                  })}
                </p>
                {a.fiatLiquidity.map((l) => (
                  <p key={l.fiatCurrency}>
                    {translateUi('Available fiat: {value}', {
                      value: formatMinor(l.availableBalance, l.fiatCurrency),
                    })}
                  </p>
                ))}
                {a.status === 'ACTIVE' && (
                  <>
                    <label>
                      {translateUi('Suspension reason for') + ' '}
                      {a.displayName}
                      <textarea
                        value={actionNotes[`suspend:${a.id}`] ?? ''}
                        maxLength={500}
                        disabled={busy}
                        onChange={(e) =>
                          setActionNotes((v) => ({ ...v, [`suspend:${a.id}`]: e.target.value }))
                        }
                      />
                    </label>
                    <ConfirmAction
                      label={translateUi('Suspend {displayName}', { displayName: a.displayName })}
                      disabled={busy || (actionNotes[`suspend:${a.id}`] ?? '').trim().length < 5}
                      onConfirm={() =>
                        change(`/agents/${a.id}/suspend`, {
                          reason: actionNotes[`suspend:${a.id}`],
                        })
                      }
                    />
                  </>
                )}
                {(a.status === 'TEMPORARILY_SUSPENDED' || a.status === 'UNDER_REVIEW') && (
                  <ConfirmAction
                    label={translateUi('Reactivate {displayName}', { displayName: a.displayName })}
                    disabled={busy}
                    onConfirm={() => change(`/agents/${a.id}/reactivate`, {})}
                  />
                )}
                {a.paymentAccounts
                  .filter((p) => !p.safetyHold && p.status !== 'DISABLED')
                  .map((p) => (
                    <p key={p.id}>
                      {p.methodDef.name}{' '}
                      <ConfirmAction
                        label={translateUi('Disable account')}
                        disabled={busy || !p.updatedAt}
                        onConfirm={() =>
                          change(`/agents/payment-accounts/${p.id}/admin-disable`, { expectedUpdatedAt: p.updatedAt })
                        }
                      />
                    </p>
                  ))}
              </article>
            ))}
            <p>
              {translateUi(
                'Funding records must represent verified backing. Initial funding is allowed once; subsequent adjustments require a super administrator. This form does not transfer bank funds.'
              )}
            </p>
            <label>
              {translateUi('Agent')}
              <select
                value={selectedAgent}
                disabled={funding.blocked}
                onChange={(e) => setSelectedAgent(e.target.value)}
              >
                <option value="">{translateUi('Select agent')}</option>
                {setup.data!.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {translateUi('Funding balance')}
              <select
                value={fundType}
                disabled={funding.blocked}
                onChange={(e) => {
                  setFundType(e.target.value);
                  setAmount('');
                }}
              >
                <option value="inventory">{translateUi('ETB deposit funding')}</option>
                <option value="liquidity">
                  {translateUi('Fiat liquidity · {currencyCode}', { currencyCode: c.currencyCode })}
                </option>
              </select>
            </label>
            <label>
              {translateUi('Operation')}
              <select
                value={fundMode}
                disabled={funding.blocked}
                onChange={(e) => setFundMode(e.target.value)}
              >
                <option value="fund">{translateUi('Initial allocation')}</option>
                <option value="adjust">{translateUi('Adjustment · super admin')}</option>
              </select>
            </label>
            <label>
              {translateUi('Amount (')}
              {fundType === 'inventory' ? 'ETB' : c.currencyCode})
              <input
                value={amount}
                disabled={funding.blocked}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p>
              {translateUi('Review amount: {value}', {
                value:
                  signed === null
                    ? translateUi('Enter a valid amount')
                    : fundType === 'inventory'
                      ? formatEtb(signed)
                      : formatMinor(signed, c.currencyCode),
              })}
            </p>
            <ConfirmAction
              label={translateUi('Confirm backed allocation')}
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
        {translateUi('Funding adjustment reason')}
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
          <summary>{translateUi(title)}</summary>
          {q.isPending ? (
            <p>{translateUi('Loading…')}</p>
          ) : q.isError ? (
            <p role="alert">
              {translateUi('Could not load reviews.') + ' '}
              <button onClick={() => q.refetch()}>{translateUi('Retry')}</button>
            </p>
          ) : !q.data?.length ? (
            <p>{translateUi('No pending reviews.')}</p>
          ) : (
            q.data.map((r) => {
              const paymentAccount = path === 'payment-accounts';
              const expectedUpdatedAt = paymentAccount ? displayedPaymentAccountVersion(r) : null;
              const reviewUnavailable = paymentAccount && (!expectedUpdatedAt || q.isFetching);
              const noteKey = `${path}:${r.id}:${r.updatedAt ?? ''}`;
              const reviewNote = actionNotes[noteKey] ?? '';
              const approveBody = paymentAccount ? { expectedUpdatedAt } : { reviewNote };
              const rejectBody = {
                reviewNote,
                ...(paymentAccount ? { expectedUpdatedAt } : {}),
              };
              return (
                <article
                  className="payment-record"
                  key={
                    paymentAccount ? JSON.stringify([r.id, r.updatedAt, r.accountDetails]) : r.id
                  }
                  aria-label={translateUi('{value} review {id}', {
                    value: paymentAccount
                      ? translateUi('Payment account')
                      : translateUi('Agent application'),
                    id: r.id,
                  })}
                >
                  <h3>{r.agent.displayName}</h3>
                  <p>
                    {translateUi('Country: {value}', {
                      value:
                        countries.data?.find(
                          (c) => c.id === (paymentAccount ? r.countryId : r.agent.countryId)
                        )?.name ??
                        (paymentAccount
                          ? (r.countryId ?? translateUi('Unavailable'))
                          : r.agent.countryId),
                    })}
                  </p>
                  {paymentAccount && (
                    <p>
                      {translateUi('Payment method: {value}', {
                        value: r.methodDef?.name ?? translateUi('Unavailable'),
                      })}
                    </p>
                  )}
                  <label>
                    {translateUi('Review reason for') + ' '}
                    {r.agent.displayName}
                    <textarea
                      value={reviewNote}
                      maxLength={500}
                      disabled={busy || reviewUnavailable}
                      onChange={(e) => setActionNotes((v) => ({ ...v, [noteKey]: e.target.value }))}
                    />
                  </label>
                  <pre className="payment-evidence">
                    {JSON.stringify(
                      paymentAccount ? r.accountDetails : (r.submittedData ?? r.accountDetails),
                      null,
                      2
                    )}
                  </pre>
                  {paymentAccount && !expectedUpdatedAt && (
                    <p role="alert">
                      {translateUi(
                        'Account details or review version are unavailable. Reload this review before making a decision.'
                      )}
                    </p>
                  )}
                  <ConfirmAction
                    label={translateUi('Approve verified record')}
                    disabled={busy || reviewUnavailable}
                    onConfirm={() => {
                      if (busy || reviewUnavailable) return;
                      void change(`/agents/${path}/${r.id}/approve`, approveBody);
                    }}
                  />
                  <ConfirmAction
                    label={translateUi('Reject with reason')}
                    disabled={busy || reviewUnavailable || reviewNote.trim().length < 5}
                    onConfirm={() => {
                      if (busy || reviewUnavailable || reviewNote.trim().length < 5) return;
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
        <summary>{translateUi('Latest 100 deposit orders')}</summary>
        {deposits.isPending ? (
          <p>{translateUi('Loading…')}</p>
        ) : deposits.isError ? (
          <p role="alert">
            {translateUi('Could not load orders.') + ' '}
            <button onClick={() => deposits.refetch()}>{translateUi('Retry')}</button>
          </p>
        ) : !deposits.data?.length ? (
          <p>{translateUi('No deposit orders.')}</p>
        ) : (
          deposits.data.map((d) => (
            <PaymentCard key={d.id} payment={d}>
              <p>{translateUi('Agent: {displayName}', { displayName: d.agent.displayName })}</p>
            </PaymentCard>
          ))
        )}
      </details>
      <details>
        <summary>{translateUi('Crypto integration status')}</summary>
        <p>
          {translateUi(
            'USDT, USDC, Bitcoin, Ethereum and Solana are planned options. Your existing provider must be identified before network mappings, authenticated payment notifications and settlement can be connected. Crypto remains unavailable; there is no manual “mark paid” bypass.'
          )}
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
