import { LatePaymentReport, LatePaymentCases } from './wallet-late-payments';
import { currencyMinorDigits, inputToMinor, formatMinor } from '@/lib/payment-money';
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { boundedRequest } from '@/lib/bounded-request';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import './wallet-payments.css';

type Country = {
  id: string;
  name: string;
  currencyCode: string;
  agentPaymentEnabled?: boolean;
  usdPricingEnabled?: boolean;
};
type Agent = {
  id: string;
  countryId: string;
  displayName: string;
  minOrderAmount: number | null;
  maxOrderAmount: number | null;
  paymentAccounts: { id: string; methodDef: { name: string } }[];
};
type Options = { countries: Country[]; agents: Agent[]; isAgent: boolean; isAdmin: boolean; crypto?: { assets: { symbol: string; name: string; network: string; available: boolean; reason: string }[] } };
type Payment = {
  id: string;
  orderNumber?: string;
  status: string;
  coinAmount: number;
  fiatAmount: string | number;
  fiatCurrency: string;
  createdAt: string;
  paymentSnapshot?: Record<string, unknown>;
  pricingSnapshot?: {
    minorDigits: number;
    source: string;
    localPerUsd: string;
    observedAt: string;
    expiresAt?: string;
    feeMinor: number;
  };
};
function depositDeadline(payment: Payment): number {
  const windowEnd = Date.parse(payment.createdAt) + 15 * 60 * 1000;
  const rateEnd = Date.parse(payment.pricingSnapshot?.expiresAt ?? '');
  return Math.min(windowEnd, Number.isFinite(rateEnd) ? rateEnd : Infinity);
}
type Account = {
  id: string;
  countryId: string;
  status: string;
  displayLabel?: string;
  accountDetails: Record<string, unknown>;
};
type Method = { id: string; name: string; fieldSchema: { requiredFields: string[] } };
type Quote = {
  id: string;
  coinAmount: number;
  fiatAmount: string;
  fiatCurrency: string;
  expiresAt: string;
};
const get = async <T,>(path: string) => unwrapData(await api.get<T>(path));
export function PaymentNavigation() {
  return (
    <nav aria-label="Wallet sections" className="payment-tabs">
      {[
        ['/wallet', 'Overview'],
        ['/wallet/deposit', 'Deposit'],
        ['/wallet/withdraw', 'Withdraw'],
        ['/wallet/activity', 'Requests'],
      ].map(([to, label]) => (
        <NavLink key={to} to={to} end>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
export function WalletPaymentsPage() {
  const { user } = useAuth();
  return user ? <Payments key={user.id} userId={user.id} /> : null;
}
function Payments({ userId }: { userId: string }) {
  const { section = 'activity' } = useParams();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const options = useQuery({
    queryKey: ['payments', 'options', userId],
    queryFn: () => get<Options>('/wallet/payment-options'),
  });
  const balance = useQuery({
    queryKey: ['wallet', userId],
    queryFn: () =>
      get<{ coinsBalance: number; coinAvailability?: { spendable: number; betOnly: number } }>(
        '/wallet'
      ),
    refetchInterval: 15000,
  });
  const orders = useQuery({
    queryKey: ['payments', 'orders', userId],
    queryFn: () => get<Payment[]>('/agent-orders/me'),
    refetchInterval: 15000,
  });
  const withdrawals = useQuery({
    queryKey: ['payments', 'withdrawals', userId],
    queryFn: () => get<Payment[]>('/withdrawals/me'),
    refetchInterval: 15000,
  });
  const accounts = useQuery({
    queryKey: ['payments', 'accounts', userId],
    queryFn: () => get<Account[]>('/withdrawals/payout-accounts'),
  });
  const [countryId, setCountry] = useState(''),
    [agentId, setAgent] = useState(''),
    [paymentAccountId, setPaymentAccount] = useState(''),
    [amount, setAmount] = useState('');
  const [accountId, setAccount] = useState(''),
    [methodId, setMethod] = useState(''),
    [details, setDetails] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState(''),
    [preparing, setPreparing] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [verification, setVerification] = useState(''),
    [verificationMessage, setVerificationMessage] = useState('');
  const [dispute, setDispute] = useState<{ id: string; kind: string } | null>(null),
    [reason, setReason] = useState('');
  const action = useWalletAction();
  const country = options.data?.countries.find((c) => c.id === countryId),
    agent = options.data?.agents.find((a) => a.id === agentId && a.countryId === countryId);
  const methods = useQuery({
    queryKey: ['payments', 'methods', countryId],
    queryFn: () => get<Method[]>(`/agent-config/countries/${countryId}/payment-methods/active`),
    enabled: !!countryId,
  });
  const method = methods.data?.find((m) => m.id === methodId);
  const minorDigits = country ? currencyMinorDigits(country.currencyCode) : 2;
  const depositMinor = inputToMinor(amount, minorDigits);
  const validAmount =
    section === 'deposit'
      ? depositMinor !== null
      : /^\d+$/.test(amount) &&
        Number.isSafeInteger(Number(amount)) &&
        Number(amount) > 0 &&
        Number(amount) <= 1_000_000_000;
  const pricing = useQuery({
    queryKey: ['payments', 'usd-preview', countryId, section, depositMinor],
    queryFn: () =>
      get<{
        policy: {
          localPerUsd: string;
          observedAt: string;
          expiresAt: string;
          p2pDepositMinUsdCents: number;
          p2pWithdrawalAboveUsdCents: number;
        };
        preview: { coinAmount: number } | null;
      }>(
        `/agent-config/countries/${countryId}/deposit-preview${section === 'deposit' && depositMinor ? `?fiatAmount=${depositMinor}` : ''}`
      ),
    enabled: !!country?.usdPricingEnabled && country.agentPaymentEnabled !== false,
    retry: false,
    refetchInterval: 30000,
  });
  const packages = useQuery({
    queryKey: ['payments', 'coin-packages'],
    queryFn: () =>
      get<
        Array<{
          id: string;
          name: string;
          coinAmount: number;
          usdDisplay: string;
          featured: boolean;
        }>
      >('/agent-config/coin-packages'),
    enabled: section === 'deposit' && !!country?.usdPricingEnabled,
  });
  function changeCountry(value: string) {
    setCountry(value);
    setAmount('');
    setAgent('');
    setPaymentAccount('');
    setAccount('');
    setMethod('');
    setDetails({});
    setQuote(null);
    setConfirm(false);
  }
  async function prepare() {
    setPreparing(true);
    setError('');
    setQuote(null);
    try {
      setQuote(
        unwrapData(
          await boundedRequest((signal) =>
            api.post<Quote>(
              '/withdrawals/quotes',
              { countryId, coinAmount: Number(amount) },
              undefined,
              { signal }
            )
          )
        )
      );
    } catch (e) {
      setError(walletError(e));
    } finally {
      setPreparing(false);
    }
  }
  async function saveAccount() {
    setPreparing(true);
    setError('');
    try {
      const a = unwrapData(
        await boundedRequest((signal) =>
          api.post<Account>(
            '/withdrawals/payout-accounts',
            {
              countryId,
              methodDefId: methodId,
              accountDetails: details,
              displayLabel: method?.name,
            },
            undefined,
            { signal }
          )
        )
      );
      setDetails({});
      await accounts.refetch();
      setAccount(a.id);
    } catch (e) {
      setError(walletError(e));
    } finally {
      setPreparing(false);
    }
  }
  async function verifyStepUp() {
    setPreparing(true);
    setError('');
    try {
      await boundedRequest((signal) =>
        api.post(
          '/security/step-up/verify',
          { purpose: 'WITHDRAWAL_CREATE', factorType: 'TOTP', code: verification },
          undefined,
          { signal }
        )
      );
      setVerification('');
      setVerificationMessage('Verification accepted. You can confirm the withdrawal now.');
    } catch (e) {
      setError(walletError(e));
      setVerification('');
    } finally {
      setPreparing(false);
    }
  }
  const busy = action.blocked || preparing;
  if (!['deposit', 'withdraw', 'activity'].includes(section))
    return <Navigate to="/wallet" replace />;
  return (
    <div className="payments-page">
      <header>
        <p className="payment-eyebrow">YOUR MONEY, CLEARLY TRACKED</p>
        <h1>Wallet</h1>
        <p>Manage Coin requests and follow every step of processing.</p>
      </header>
      <PaymentNavigation />
      <section className="payment-balance" aria-label="Coin balance">
        {balance.isPending ? (
          <p role="status">Loading balance…</p>
        ) : balance.isError ? (
          <p role="alert">
            Could not load your balance. <button onClick={() => balance.refetch()}>Retry</button>
          </p>
        ) : (
          <>
            <div>
              <span>Total Coins</span>
              <strong>{balance.data.coinsBalance?.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <span>Spendable Coins · eligibility applies</span>
              <strong>{balance.data.coinAvailability?.spendable.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <span>Bet-only rewards</span>
              <strong>{balance.data.coinAvailability?.betOnly.toLocaleString() ?? '—'}</strong>
            </div>
          </>
        )}
      </section>
      <div className="payment-disclosure">
        Deposits are agent-assisted Coin purchases. Payment happens through the approved method
        shown on your order. Game Points, bet-only rewards and practice credits cannot be withdrawn.
      </div>
      {options.isPending ? (
        <p role="status">Loading payment options…</p>
      ) : options.isError ? (
        <div role="alert">
          Payment options could not load. <button onClick={() => options.refetch()}>Retry</button>
        </div>
      ) : (
        <>
          <Link className="payment-link" to="/wallet/agent-setup">Payment agent setup</Link>
          {(options.data?.isAgent || options.data?.isAdmin) && (
            <Link className="payment-link" to={options.data?.isAdmin ? '/admin' : '/agent'}>
              {options.data?.isAdmin ? 'Administration dashboard →' : 'Agent workspace →'}
            </Link>
          )}
          {section === 'deposit' && options.data?.crypto?.assets && (
            <section className="payment-panel" aria-label="Crypto deposit options">
              <h2>Crypto deposits</h2>
              <p>Choose an asset once payment processing is connected. No crypto deposit addresses are available yet.</p>
              <div className="payment-actions">{options.data.crypto.assets.map(asset => (
                <article className="payment-record" key={asset.symbol}>
                  <h3>{asset.name} · {asset.symbol}</h3><p>{asset.network}</p>
                  <span>{asset.reason}</span>
                </article>
              ))}</div>
            </section>
          )}
          {(section === 'deposit' || section === 'withdraw') && (
            <section className="payment-panel">
              <h2>{section === 'deposit' ? 'Deposit · buy Coins' : 'Withdraw Coins'}</h2>
              {!options.data?.countries.length ? (
                <p>
                  No payment countries are enabled. New requests are unavailable; existing requests
                  remain below.
                </p>
              ) : (
                <>
                  <label>
                    Country
                    <select
                      value={countryId}
                      onChange={(e) => changeCountry(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">Choose your country</option>
                      {options.data.countries.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.currencyCode}
                        </option>
                      ))}
                    </select>
                  </label>
                  {country && (
                    <p>
                      Agent P2P:{' '}
                      {country.agentPaymentEnabled === false ? 'unavailable' : 'available'} ·
                      Crypto: not yet available
                    </p>
                  )}
                  {country?.usdPricingEnabled && (
                    <div className="payment-disclosure">
                      <strong>96 Coins = USD 1</strong>
                      {country.agentPaymentEnabled === false ? (
                        <p role="status">Payments are paused in this country. New quotes are unavailable.</p>
                      ) : pricing.isPending ? (
                        <p>Loading current rate…</p>
                      ) : pricing.isError ? (
                        <p role="alert">{walletError(pricing.error)}</p>
                      ) : (
                        pricing.data && (
                          <>
                            <p>
                              USD 1 = {pricing.data.policy.localPerUsd} {country.currencyCode}. Fee:
                              0.
                            </p>
                            <p>
                              Deposit minimum: USD{' '}
                              {(pricing.data.policy.p2pDepositMinUsdCents / 100).toFixed(2)}.
                              Withdrawal must exceed USD{' '}
                              {(pricing.data.policy.p2pWithdrawalAboveUsdCents / 100).toFixed(2)}.
                            </p>
                            {pricing.data.preview && (
                              <p>
                                You receive {pricing.data.preview.coinAmount.toLocaleString()}{' '}
                                Coins. Final amount is fixed when the order is created.
                              </p>
                            )}
                            <p>
                              Rate observed{' '}
                              {new Date(pricing.data.policy.observedAt).toLocaleString()}; expires{' '}
                              {new Date(pricing.data.policy.expiresAt).toLocaleString()}.
                            </p>
                          </>
                        )
                      )}
                      {section === 'deposit' && packages.data && (
                        <details>
                          <summary>Coin bundle reference prices</summary>
                          <p>
                            Prices are approximate USD equivalents. Enter your payment amount below;
                            the server calculates Coins using the current rate. Route minimums
                            apply.
                          </p>
                          {packages.data.map((p) => (
                            <p key={p.id}>
                              {p.name}: {p.coinAmount.toLocaleString()} Coins ≈ USD {p.usdDisplay}
                            </p>
                          ))}
                        </details>
                      )}
                    </div>
                  )}
                  <label>
                    {section === 'deposit'
                      ? `Amount to pay${country ? ' · ' + country.currencyCode : ''}`
                      : 'Coins to withdraw'}
                    <input
                      inputMode={section === 'deposit' ? 'decimal' : 'numeric'}
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        setQuote(null);
                        setConfirm(false);
                      }}
                      disabled={busy}
                    />
                  </label>
                  {amount && !validAmount && (
                    <p role="alert">
                      Enter a valid positive amount. Deposits use local currency; withdrawals use
                      whole Coins.
                    </p>
                  )}
                  {section === 'deposit' ? (
                    <>
                      <label>
                        Agent
                        <select
                          value={agentId}
                          onChange={(e) => {
                            setAgent(e.target.value);
                            setPaymentAccount('');
                            setConfirm(false);
                          }}
                          disabled={busy || !countryId}
                        >
                          <option value="">Choose an agent</option>
                          {options.data.agents
                            .filter((a) => a.countryId === countryId)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.displayName}
                              </option>
                            ))}
                        </select>
                      </label>
                      {countryId && !options.data.agents.some((a) => a.countryId === countryId) && (
                        <p>No approved agents currently serve this country.</p>
                      )}
                      {agent && (
                        <>
                          <p>
                            Order limits:{' '}
                            {formatMinor(agent.minOrderAmount ?? 1, country!.currencyCode)}–
                            {agent.maxOrderAmount
                              ? formatMinor(agent.maxOrderAmount, country!.currencyCode)
                              : 'subject to available inventory'}
                          </p>
                          <label>
                            Payment method
                            <select
                              value={paymentAccountId}
                              onChange={(e) => {
                                setPaymentAccount(e.target.value);
                                setConfirm(false);
                              }}
                              disabled={busy}
                            >
                              <option value="">Choose a method</option>
                              {agent.paymentAccounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.methodDef.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      )}
                      <p>
                        The server fixes the exchange rate and Coin amount when the order is
                        created. Review its exact payment instructions before sending funds.
                      </p>
                      <label className="payment-check">
                        <input
                          type="checkbox"
                          checked={confirm}
                          onChange={(e) => setConfirm(e.target.checked)}
                          disabled={busy}
                        />
                        Create an order for {amount || '—'} {country?.currencyCode}. No payment is
                        sent automatically.
                      </label>
                      <button
                        className="payment-primary"
                        disabled={
                          busy ||
                          !validAmount ||
                          !agent ||
                          !paymentAccountId ||
                          !confirm ||
                          country?.agentPaymentEnabled === false ||
                          (!!country?.usdPricingEnabled && (pricing.isError || !pricing.data?.preview))
                        }
                        onClick={() => {
                          setConfirm(false);
                          void action.run('/agent-orders', {
                            countryId,
                            agentId,
                            paymentAccountId,
                            fiatAmount: depositMinor,
                          });
                        }}
                      >
                        Create deposit request
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        Payout account
                        <select
                          value={accountId}
                          onChange={(e) => {
                            setAccount(e.target.value);
                            setConfirm(false);
                          }}
                          disabled={busy}
                        >
                          <option value="">Choose a payout account</option>
                          {accounts.data
                            ?.filter((a) => a.countryId === countryId && a.status === 'ACTIVE')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.displayLabel || 'Payout account'} ·{' '}
                                {Object.values(a.accountDetails).join(' · ')}
                              </option>
                            ))}
                        </select>
                      </label>
                      {accounts.isError && (
                        <p role="alert">
                          Payout accounts could not load.{' '}
                          <button onClick={() => accounts.refetch()}>Retry</button>
                        </p>
                      )}
                      {countryId && (
                        <details>
                          <summary>Add a payout account</summary>
                          <label>
                            Method
                            <select
                              value={methodId}
                              onChange={(e) => {
                                setMethod(e.target.value);
                                setDetails({});
                              }}
                              disabled={busy}
                            >
                              <option value="">Choose a method</option>
                              {methods.data?.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {methods.isError && (
                            <p role="alert">
                              Could not load payment methods.{' '}
                              <button onClick={() => methods.refetch()}>Retry</button>
                            </p>
                          )}
                          {method?.fieldSchema.requiredFields.map((field) => (
                            <label key={field}>
                              {field.replaceAll('_', ' ')}
                              <input
                                autoComplete="off"
                                value={details[field] ?? ''}
                                onChange={(e) =>
                                  setDetails({ ...details, [field]: e.target.value })
                                }
                                disabled={busy}
                              />
                            </label>
                          ))}
                          <button
                            disabled={
                              busy ||
                              !method ||
                              !method.fieldSchema.requiredFields.every((f) => details[f]?.trim())
                            }
                            onClick={saveAccount}
                          >
                            Save payout account
                          </button>
                        </details>
                      )}
                      <p>Only eligible Coins can be withdrawn. Current country limits apply and are checked when requesting a quote.</p>
                      <button
                        disabled={
                          busy || !validAmount || Number(amount) < 100 || !countryId || !accountId
                        }
                        onClick={prepare}
                      >
                        Get withdrawal quote
                      </button>
                      {quote && (
                        <div className="payment-quote">
                          <h3>Review your withdrawal</h3>
                          <p>
                            {quote.coinAmount} Coins →{' '}
                            {formatMinor(quote.fiatAmount, quote.fiatCurrency)}
                          </p>
                          <p>
                            Quote expires {new Date(quote.expiresAt).toLocaleTimeString()}. The
                            server rechecks your balance, eligibility, limits and agent liquidity.
                          </p>
                          <label className="payment-check">
                            <input
                              type="checkbox"
                              checked={confirm}
                              onChange={(e) => setConfirm(e.target.checked)}
                              disabled={busy}
                            />
                            I checked the payout account and amount.
                          </label>
                          <details>
                            <summary>Account requires two-step verification?</summary>
                            <p><Link to="/profile#security">Set up your authenticator in Profile</Link> if you haven’t enabled one yet.</p>
                            <label>
                              Authenticator code
                              <input
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                value={verification}
                                onChange={(e) => setVerification(e.target.value)}
                              />
                            </label>
                            <button
                              disabled={busy || !/^\d{6}$/.test(verification)}
                              onClick={verifyStepUp}
                            >
                              Verify withdrawal
                            </button>
                          </details>
                          {verificationMessage && <p role="status">{verificationMessage}</p>}
                          <button
                            className="payment-primary"
                            disabled={busy || !confirm}
                            onClick={() => {
                              setConfirm(false);
                              void action.run('/withdrawals', {
                                quoteId: quote.id,
                                payoutAccountId: accountId,
                              });
                            }}
                          >
                            Confirm withdrawal
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="payment-error">
          {error}
        </p>
      )}
      {action.message && (
        <p role="status" className="payment-disclosure">
          {action.message}
        </p>
      )}
      {action.pending && (
        <button
          className="payment-primary"
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          Retry saved request
        </button>
      )}
      <section className="payment-panel">
        <h2>Deposit requests</h2>
        {orders.isPending ? (
          <p>Loading requests…</p>
        ) : orders.isError ? (
          <p role="alert">
            Could not load deposit requests. <button onClick={() => orders.refetch()}>Retry</button>
          </p>
        ) : !orders.data?.length ? (
          <p>No deposit requests yet.</p>
        ) : (
          orders.data.map((p) => (
            <PaymentCard key={p.id} payment={p}>
              {p.status === 'CREATED' && (
                <>
                  <p role="status">
                    {depositDeadline(p) > now
                      ? `Payment window closes at ${new Date(depositDeadline(p)).toLocaleTimeString()}. Send only while this window is open.`
                      : 'Payment window expired. Do not send money. If you already paid, contact payment support with this order number and your transfer receipt.'}
                  </p>
                  <ConfirmAction
                    label="I have sent the payment"
                    disabled={busy || depositDeadline(p) <= now}
                    onConfirm={() => action.run(`/agent-orders/${p.id}/submit-payment`)}
                  />
                  <ConfirmAction
                    label="Cancel unpaid order"
                    disabled={busy}
                    onConfirm={() => action.run(`/agent-orders/${p.id}/cancel`)}
                  />
                </>
              )}
              {['EXPIRED', 'CANCELLED'].includes(p.status) && (
                <LatePaymentReport orderId={p.id} currency={p.fiatCurrency} />
              )}
              {p.status === 'PAYMENT_SUBMITTED' && (
                <button disabled={busy} onClick={() => setDispute({ id: p.id, kind: 'deposit' })}>
                  Report a problem
                </button>
              )}
            </PaymentCard>
          ))
        )}
      </section>
      <section className="payment-panel">
        <h2>Withdrawal requests</h2>
        {withdrawals.isPending ? (
          <p>Loading requests…</p>
        ) : withdrawals.isError ? (
          <p role="alert">
            Could not load withdrawal requests.{' '}
            <button onClick={() => withdrawals.refetch()}>Retry</button>
          </p>
        ) : !withdrawals.data?.length ? (
          <p>No withdrawal requests yet.</p>
        ) : (
          withdrawals.data.map((p) => (
            <PaymentCard key={p.id} payment={p}>
              {p.status === 'HELD' && (
                <ConfirmAction
                  label="Cancel and return held Coins"
                  disabled={busy}
                  onConfirm={() => action.run(`/withdrawals/${p.id}/cancel`)}
                />
              )}
              {p.status === 'EXPIRED' && (
                <p>Unpaid order expired. If you already paid, contact payment support with this order number and your transfer receipt.</p>
              )}
              {p.status === 'PAYMENT_SUBMITTED' && (
                <ConfirmAction
                  label="Confirm money received"
                  disabled={busy}
                  onConfirm={() => action.run(`/withdrawals/${p.id}/confirm-receipt`)}
                />
              )}
              {['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED'].includes(p.status) && (
                <button
                  disabled={busy}
                  onClick={() => setDispute({ id: p.id, kind: 'withdrawal' })}
                >
                  Report a problem
                </button>
              )}
            </PaymentCard>
          ))
        )}
      </section>
      <LatePaymentCases />
      {dispute && (
        <section className="payment-panel">
          <h2>Report a payment problem</h2>
          <p>Request {dispute.id}</p>
          <label>
            Describe the issue
            <textarea maxLength={4000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            disabled={busy || !reason.trim()}
            onClick={() => {
              void action.run(
                dispute.kind === 'deposit'
                  ? '/agent-disputes'
                  : `/withdrawals/${dispute.id}/dispute`,
                {
                  ...(dispute.kind === 'deposit' ? { orderId: dispute.id } : {}),
                  reason: 'OTHER',
                  description: reason,
                }
              );
              setDispute(null);
              setReason('');
            }}
          >
            Submit report
          </button>
          <button onClick={() => setDispute(null)}>Back</button>
        </section>
      )}
    </div>
  );
}
export function ConfirmAction({
  label,
  disabled,
  onConfirm,
}: {
  label: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className="payment-actions">
      <span>Confirm: {label.toLowerCase()}?</span>
      <button
        disabled={disabled}
        onClick={() => {
          setConfirm(false);
          onConfirm();
        }}
      >
        Confirm
      </button>
      <button onClick={() => setConfirm(false)}>Back</button>
    </span>
  ) : (
    <button disabled={disabled} onClick={() => setConfirm(true)}>
      {label}
    </button>
  );
}
export function PaymentCard({
  payment: p,
  children,
}: {
  payment: Payment;
  children?: React.ReactNode;
}) {
  return (
    <article className="payment-record">
      <div>
        <strong>{p.orderNumber ?? p.id}</strong>
        <span className="payment-status">{p.status.replaceAll('_', ' ')}</span>
      </div>
      <p>
        {p.coinAmount.toLocaleString()} Coins ·{' '}
        {formatMinor(p.fiatAmount, p.fiatCurrency, p.pricingSnapshot?.minorDigits)}
      </p>
      {p.pricingSnapshot && (
        <p>
          USD 1 = {p.pricingSnapshot.localPerUsd} {p.fiatCurrency} · fee{' '}
          {formatMinor(p.pricingSnapshot.feeMinor, p.fiatCurrency, p.pricingSnapshot.minorDigits)} ·
          rate {new Date(p.pricingSnapshot.observedAt).toLocaleString()}
        </p>
      )}
      <time>{new Date(p.createdAt).toLocaleString()}</time>
      {p.paymentSnapshot && (
        <details>
          <summary>Payment details</summary>
          <dl>
            {Object.entries(p.paymentSnapshot).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll('_', ' ')}</dt>
                <dd>{typeof value === 'string' ? value : 'Contact support for this detail'}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="payment-actions">{children}</div>
    </article>
  );
}
