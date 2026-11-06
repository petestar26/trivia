import { LatePaymentReport, LatePaymentCases } from './wallet-late-payments';
import {
  currencyMinorDigits,
  inputToMinor,
  formatMinor,
  formatEtb,
  etbMinimumMinor,
} from '@/lib/payment-money';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { boundedRequest } from '@/lib/bounded-request';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import './wallet-payments.css';
import {
  PaymentNavigation,
  PaymentMethodChooser,
  PaymentSteps,
  paymentPath,
} from './wallet-navigation';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
type Options = {
  countries: Country[];
  agents: Agent[];
  isAgent: boolean;
  isAdmin: boolean;
  withdrawalsEnabled?: boolean;
  crypto?: {
    assets: { symbol: string; name: string; network: string; available: boolean; reason: string }[];
  };
};
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
export { PaymentNavigation } from './wallet-navigation';
export function WalletPaymentsPage() {
  const { user } = useAuth();
  const { section } = useParams();
  return user ? <Payments key={`${user.id}:${section}`} userId={user.id} /> : null;
}
function Payments({ userId }: { userId: string }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

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
  const withdrawalMinor = inputToMinor(amount, 2);
  const validAmount =
    depositMinor !== null &&
    (section === 'deposit' || (withdrawalMinor !== null && withdrawalMinor <= 1_000_000_000));
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
  const withdrawalPolicy = pricing.data?.policy;
  const withdrawalMinimum = withdrawalPolicy
    ? etbMinimumMinor(
        withdrawalPolicy.localPerUsd,
        withdrawalPolicy.p2pWithdrawalAboveUsdCents,
        true
      )
    : null;
  const withdrawalPricingReady =
    options.data?.withdrawalsEnabled !== false &&
    country?.agentPaymentEnabled !== false &&
    (!country?.usdPricingEnabled ||
      (!pricing.isError &&
        withdrawalMinimum !== null &&
        Number.isSafeInteger(withdrawalMinimum) &&
        Date.parse(withdrawalPolicy!.expiresAt) > now &&
        (withdrawalMinor ?? 0) >= withdrawalMinimum));
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
    setConfirm(false);
    setPreparing(true);
    setError('');
    setQuote(null);
    try {
      setQuote(
        unwrapData(
          await boundedRequest((signal) =>
            api.post<Quote>(
              '/withdrawals/quotes',
              { countryId, coinAmount: withdrawalMinor },
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
    <div className="payments-page wallet-member">
      <header>
        <p className="payment-eyebrow">{translateUi('YOUR MONEY, CLEARLY TRACKED')}</p>
        <h1>
          {section === 'deposit'
            ? translateUi('Deposit')
            : section === 'withdraw'
              ? translateUi('Withdraw')
              : translateUi('Payment activity')}
        </h1>
        <p>
          {section === 'activity'
            ? translateUi('Track your requests and see what happens next.')
            : translateUi('Choose your method, enter the details, then review your request.')}
        </p>
      </header>
      <PaymentNavigation />
      {section !== 'activity' && (
        <>
          <PaymentMethodChooser direction={section as 'deposit' | 'withdraw'} method="agent" />
          <PaymentSteps direction={section as 'deposit' | 'withdraw'} method="agent" />
        </>
      )}
      <section className="payment-balance" aria-label={translateUi('Birr balance')}>
        {balance.isPending ? (
          <p role="status">{translateUi('Loading balance…')}</p>
        ) : balance.isError ? (
          <p role="alert">
            {translateUi('Could not load your balance.') + ' '}
            <button onClick={() => balance.refetch()}>{translateUi('Retry')}</button>
          </p>
        ) : (
          <>
            <div>
              <span>{translateUi('Birr balance')}</span>
              <strong>{formatEtb(balance.data.coinsBalance)}</strong>
            </div>
            <div>
              <span>{translateUi('Available balance · eligibility applies')}</span>
              <strong>
                {balance.data.coinAvailability
                  ? formatEtb(balance.data.coinAvailability.spendable)
                  : '—'}
              </strong>
            </div>
            <div>
              <span>{translateUi('Bet-only rewards')}</span>
              <strong>
                {balance.data.coinAvailability
                  ? formatEtb(balance.data.coinAvailability.betOnly)
                  : '—'}
              </strong>
            </div>
          </>
        )}
      </section>
      <details className="wallet-payment-rules">
        <summary>{translateUi('Which balance can I use?')}</summary>
        <p>
          {translateUi(
            'Agent deposits add Birr to your wallet. Payment happens through the approved method shown on your order. Game Points, bet-only rewards and practice credits cannot be withdrawn.'
          )}
        </p>
      </details>
      {options.isPending ? (
        <p role="status">{translateUi('Loading payment options…')}</p>
      ) : options.isError ? (
        <div role="alert">
          {translateUi('Payment options could not load.') + ' '}
          <button onClick={() => options.refetch()}>{translateUi('Retry')}</button>
        </div>
      ) : (
        <>
          {(options.data?.isAgent || options.data?.isAdmin) && (
            <Link className="payment-link" to={options.data?.isAdmin ? '/admin' : '/agent'}>
              {options.data?.isAdmin
                ? translateUi('Administration dashboard →')
                : translateUi('Agent workspace →')}
            </Link>
          )}
          {(section === 'deposit' || section === 'withdraw') && (
            <section className="payment-panel">
              <h2>
                {section === 'deposit'
                  ? translateUi('Agent deposit')
                  : translateUi('Agent withdrawal')}
              </h2>
              {section === 'withdraw' && options.data?.withdrawalsEnabled === false && (
                <div className="wallet-mode-notice" role="status">
                  <strong>{translateUi('Withdrawals are awaiting payment setup')}</strong>
                  <p>
                    {translateUi(
                      'You can save your payout account below. Requests open after payout services are activated.'
                    )}
                  </p>
                </div>
              )}
              {options.data?.isAdmin && (
                <p>
                  <Link to="/admin/payments">{translateUi('Configure payment accounts')}</Link> ·{' '}
                  <Link to="/admin/pricing">{translateUi('Manage exchange rates')}</Link>
                </p>
              )}
              {!options.data?.countries.length ? (
                <p>
                  {translateUi(
                    'No payment countries are enabled. New requests are unavailable; existing requests remain below.'
                  )}
                </p>
              ) : (
                <>
                  <label>
                    {translateUi('Country')}
                    <select
                      value={countryId}
                      onChange={(e) => changeCountry(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">{translateUi('Choose your country')}</option>
                      {options.data.countries.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.currencyCode}
                        </option>
                      ))}
                    </select>
                  </label>
                  {country && (
                    <p>
                      {translateUi('Agent payments:')}{' '}
                      {country.agentPaymentEnabled === false
                        ? translateUi('setup in progress')
                        : translateUi('enabled; request checks apply')}{' '}
                      ·{' '}
                      <Link to={paymentPath(section as 'deposit' | 'withdraw', 'crypto')}>
                        {translateUi('Check USDT availability')}
                      </Link>
                    </p>
                  )}
                  {country?.agentPaymentEnabled === false && (
                    <div className="wallet-mode-notice" role="status">
                      <strong>
                        {translateUi('Payment setup is incomplete for {name}', {
                          name: country.name,
                        })}
                      </strong>
                      <p>
                        {translateUi(
                          'An approved agent receiving account, current exchange rate and funded payment service are needed. You can prepare your payout account while setup is completed.'
                        )}
                      </p>
                    </div>
                  )}
                  {country?.usdPricingEnabled && (
                    <div className="payment-disclosure">
                      <strong>{translateUi('Your wallet uses Birr (ETB)')}</strong>
                      {country.agentPaymentEnabled === false ? (
                        <p role="status">
                          {translateUi(
                            'Payments are paused in this country. New quotes are unavailable.'
                          )}
                        </p>
                      ) : pricing.isPending ? (
                        <p>{translateUi('Loading current rate…')}</p>
                      ) : pricing.isError ? (
                        <p role="alert">{walletError(pricing.error)}</p>
                      ) : (
                        pricing.data && (
                          <>
                            <p>
                              {translateUi('USD 1 = {localPerUsd} {currencyCode}. Fee: 0.', {
                                localPerUsd: pricing.data.policy.localPerUsd,
                                currencyCode: country.currencyCode,
                              })}
                            </p>
                            <p>
                              {translateUi(
                                'Deposit minimum: USD {value}. Withdrawal must exceed USD {value2}.',
                                {
                                  value: (pricing.data.policy.p2pDepositMinUsdCents / 100).toFixed(
                                    2
                                  ),
                                  value2: (
                                    pricing.data.policy.p2pWithdrawalAboveUsdCents / 100
                                  ).toFixed(2),
                                }
                              )}
                            </p>
                            {pricing.data.preview && (
                              <p>
                                {translateUi(
                                  'You receive {value}. Final amount is fixed when the order is created.',
                                  { value: formatEtb(pricing.data.preview.coinAmount) }
                                )}
                              </p>
                            )}
                            <p>
                              {translateUi('Rate observed {value}; expires {value2}.', {
                                value: new Date(pricing.data.policy.observedAt).toLocaleString(
                                  interfaceLocale
                                ),
                                value2: new Date(pricing.data.policy.expiresAt).toLocaleString(
                                  interfaceLocale
                                ),
                              })}
                            </p>
                          </>
                        )
                      )}
                    </div>
                  )}
                  <label>
                    {section === 'deposit'
                      ? translateUi('Amount to pay{value}', {
                          value: country ? ' · ' + country.currencyCode : '',
                        })
                      : translateUi('Amount to withdraw · ETB')}
                    <input
                      inputMode="decimal"
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
                      {translateUi('Enter a positive ETB amount with up to two decimal places.')}
                    </p>
                  )}
                  {section === 'deposit' ? (
                    <>
                      <label>
                        {translateUi('Agent')}
                        <select
                          value={agentId}
                          onChange={(e) => {
                            setAgent(e.target.value);
                            setPaymentAccount('');
                            setConfirm(false);
                          }}
                          disabled={busy || !countryId}
                        >
                          <option value="">{translateUi('Choose an agent')}</option>
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
                        <p>{translateUi('No approved agents currently serve this country.')}</p>
                      )}
                      {agent && (
                        <>
                          <p>
                            {translateUi('Order limits: {value}–{value2}', {
                              value: formatMinor(agent.minOrderAmount ?? 1, country!.currencyCode),
                              value2: agent.maxOrderAmount
                                ? formatMinor(agent.maxOrderAmount, country!.currencyCode)
                                : translateUi('subject to available inventory'),
                            })}
                          </p>
                          <label>
                            {translateUi('Payment method')}
                            <select
                              value={paymentAccountId}
                              onChange={(e) => {
                                setPaymentAccount(e.target.value);
                                setConfirm(false);
                              }}
                              disabled={busy}
                            >
                              <option value="">{translateUi('Choose a method')}</option>
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
                        {translateUi(
                          'Your order shows the exact amount and payment details. Create the request first, then follow its instructions.'
                        )}
                      </p>
                      <label className="payment-check">
                        <input
                          type="checkbox"
                          checked={confirm}
                          onChange={(e) => setConfirm(e.target.checked)}
                          disabled={busy}
                        />
                        {translateUi(
                          'Create an order for {amount} {currency}. No payment is sent automatically.',
                          { amount: amount || '—', currency: country?.currencyCode ?? '' }
                        )}
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
                          (!!country?.usdPricingEnabled &&
                            (pricing.isError || !pricing.data?.preview))
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
                        {translateUi('Create deposit request')}
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        {translateUi('Payout account')}
                        <select
                          value={accountId}
                          onChange={(e) => {
                            setAccount(e.target.value);
                            setConfirm(false);
                          }}
                          disabled={busy}
                        >
                          <option value="">{translateUi('Choose a payout account')}</option>
                          {accounts.data
                            ?.filter((a) => a.countryId === countryId && a.status === 'ACTIVE')
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.displayLabel || translateUi('Payout account')} ·{' '}
                                {Object.values(a.accountDetails).join(' · ')}
                              </option>
                            ))}
                        </select>
                      </label>
                      {accounts.isError && (
                        <p role="alert">
                          {translateUi('Payout accounts could not load.')}{' '}
                          <button onClick={() => accounts.refetch()}>{translateUi('Retry')}</button>
                        </p>
                      )}
                      {countryId && (
                        <details>
                          <summary>{translateUi('Add a payout account')}</summary>
                          <label>
                            {translateUi('Method')}
                            <select
                              value={methodId}
                              onChange={(e) => {
                                setMethod(e.target.value);
                                setDetails({});
                              }}
                              disabled={busy}
                            >
                              <option value="">{translateUi('Choose a method')}</option>
                              {methods.data?.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          {methods.isError && (
                            <p role="alert">
                              {translateUi('Could not load payment methods.')}{' '}
                              <button onClick={() => methods.refetch()}>
                                {translateUi('Retry')}
                              </button>
                            </p>
                          )}
                          {method?.fieldSchema.requiredFields.map((field) => (
                            <label key={field}>
                              {field
                                .replace(/([a-z])([A-Z])/g, '$1 $2')
                                .replaceAll('_', ' ')
                                .replace(/\b\w/g, (c) => c.toUpperCase())}
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
                            {translateUi('Save payout account')}
                          </button>
                        </details>
                      )}
                      <p>
                        {translateUi(
                          'Only eligible ETB balance can be withdrawn. Current country limits apply and are checked when requesting a quote.'
                        )}
                      </p>
                      {country?.usdPricingEnabled &&
                        withdrawalMinimum !== null &&
                        Number.isSafeInteger(withdrawalMinimum) && (
                          <p>
                            {translateUi('Minimum for the current policy: {value}.', {
                              value: formatEtb(withdrawalMinimum),
                            })}
                          </p>
                        )}
                      <button
                        disabled={
                          busy ||
                          !validAmount ||
                          !withdrawalPricingReady ||
                          !countryId ||
                          !accountId
                        }
                        onClick={prepare}
                      >
                        {translateUi('Get withdrawal quote')}
                      </button>
                      {quote && (
                        <div className="payment-quote">
                          <h3>{translateUi('Review your withdrawal')}</h3>
                          {Date.parse(quote.expiresAt) <= now && (
                            <p role="alert">
                              {translateUi(
                                'This quote has expired. Get a new withdrawal quote to continue.'
                              )}
                            </p>
                          )}
                          <p>
                            {formatEtb(quote.coinAmount)} →{' '}
                            {formatMinor(quote.fiatAmount, quote.fiatCurrency)}
                          </p>
                          <p>
                            {translateUi(
                              'Quote valid until {value}. Review the amount and receiving account before confirming.',
                              {
                                value: new Date(quote.expiresAt).toLocaleTimeString(
                                  interfaceLocale
                                ),
                              }
                            )}
                          </p>
                          <label className="payment-check">
                            <input
                              type="checkbox"
                              checked={confirm}
                              onChange={(e) => setConfirm(e.target.checked)}
                              disabled={busy}
                            />
                            {translateUi('I checked the payout account and amount.')}
                          </label>
                          <details>
                            <summary>
                              {translateUi('Account requires two-step verification?')}
                            </summary>
                            <p>
                              <Link to="/profile#security">
                                {translateUi('Set up your authenticator in Profile')}
                              </Link>{' '}
                              {translateUi('if you haven’t enabled one yet.')}
                            </p>
                            <label>
                              {translateUi('Authenticator code')}
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
                              {translateUi('Verify withdrawal')}
                            </button>
                          </details>
                          {verificationMessage && (
                            <p role="status">{translateUi(verificationMessage)}</p>
                          )}
                          <button
                            className="payment-primary"
                            disabled={busy || !confirm || Date.parse(quote.expiresAt) <= now}
                            onClick={() => {
                              if (Date.parse(quote.expiresAt) <= Date.now()) return;
                              setConfirm(false);
                              void action.run('/withdrawals', {
                                quoteId: quote.id,
                                payoutAccountId: accountId,
                              });
                            }}
                          >
                            {translateUi('Confirm withdrawal')}
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
          {translateUi(error)}
        </p>
      )}
      {action.message && (
        <p role="status" className="payment-disclosure">
          {translateUi(action.message)}
        </p>
      )}
      {action.pending && (
        <button
          className="payment-primary"
          disabled={action.busy}
          onClick={() => action.run(action.pending!.path, action.pending!.body)}
        >
          {translateUi('Retry saved request')}
        </button>
      )}
      <nav className="wallet-history-links" aria-label={translateUi('More payment activity')}>
        <Link to="/wallet/activity">{translateUi('All agent requests')}</Link>
        <Link to={paymentPath(section === 'withdraw' ? 'withdraw' : 'deposit', 'crypto')}>
          {translateUi('Crypto requests')}
        </Link>
      </nav>
      {section !== 'withdraw' && (
        <section className="payment-panel">
          <h2>{translateUi('Deposit requests')}</h2>
          {orders.isPending ? (
            <p>{translateUi('Loading requests…')}</p>
          ) : orders.isError ? (
            <p role="alert">
              {translateUi('Could not load deposit requests.')}{' '}
              <button onClick={() => orders.refetch()}>{translateUi('Retry')}</button>
            </p>
          ) : !orders.data?.length ? (
            <p>{translateUi('No deposit requests yet.')}</p>
          ) : (
            orders.data.map((p) => (
              <PaymentCard key={p.id} payment={p}>
                {p.status === 'CREATED' && (
                  <>
                    <p role="status">
                      {depositDeadline(p) > now
                        ? translateUi(
                            'Payment window closes at {value}. Send only while this window is open.',
                            {
                              value: new Date(depositDeadline(p)).toLocaleTimeString(
                                interfaceLocale
                              ),
                            }
                          )
                        : translateUi(
                            'Payment window expired. Do not send money. If you already paid, contact payment support with this order number and your transfer receipt.'
                          )}
                    </p>
                    <ConfirmAction
                      label={translateUi('I have sent the payment')}
                      disabled={busy || depositDeadline(p) <= now}
                      onConfirm={() => action.run(`/agent-orders/${p.id}/submit-payment`)}
                    />
                    <ConfirmAction
                      label={translateUi('Cancel unpaid order')}
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
                    {translateUi('Report a problem')}
                  </button>
                )}
              </PaymentCard>
            ))
          )}
        </section>
      )}
      {section !== 'deposit' && (
        <section className="payment-panel">
          <h2>{translateUi('Withdrawal requests')}</h2>
          {withdrawals.isPending ? (
            <p>{translateUi('Loading requests…')}</p>
          ) : withdrawals.isError ? (
            <p role="alert">
              {translateUi('Could not load withdrawal requests.')}{' '}
              <button onClick={() => withdrawals.refetch()}>{translateUi('Retry')}</button>
            </p>
          ) : !withdrawals.data?.length ? (
            <p>{translateUi('No withdrawal requests yet.')}</p>
          ) : (
            withdrawals.data.map((p) => (
              <PaymentCard key={p.id} payment={p}>
                {p.status === 'HELD' && (
                  <ConfirmAction
                    label={translateUi('Cancel and return held ETB')}
                    disabled={busy}
                    onConfirm={() => action.run(`/withdrawals/${p.id}/cancel`)}
                  />
                )}
                {p.status === 'EXPIRED' && (
                  <p>
                    {translateUi(
                      'Unpaid order expired. If you already paid, contact payment support with this order number and your transfer receipt.'
                    )}
                  </p>
                )}
                {p.status === 'PAYMENT_SUBMITTED' && (
                  <ConfirmAction
                    label={translateUi('Confirm money received')}
                    disabled={busy}
                    onConfirm={() => action.run(`/withdrawals/${p.id}/confirm-receipt`)}
                  />
                )}
                {p.status === 'PAYOUT_IN_PROGRESS' && (
                  <p>
                    {translateUi(
                      'The agent is processing your payout. If it is delayed, contact payment support with this request number.'
                    )}
                  </p>
                )}
                {p.status === 'PAYMENT_SUBMITTED' && (
                  <button
                    disabled={busy}
                    onClick={() => setDispute({ id: p.id, kind: 'withdrawal' })}
                  >
                    {translateUi('Report a problem')}
                  </button>
                )}
              </PaymentCard>
            ))
          )}
        </section>
      )}
      {section === 'activity' && <LatePaymentCases />}
      {dispute && (
        <section className="payment-panel">
          <h2>{translateUi('Report a payment problem')}</h2>
          <p>{translateUi('Request {id}', { id: dispute.id })}</p>
          <label>
            {translateUi('Describe the issue')}
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
            {translateUi('Submit report')}
          </button>
          <button onClick={() => setDispute(null)}>{translateUi('Back')}</button>
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
  const { t: translateUi } = useInterfaceLanguage();

  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <span className="payment-actions">
      <span>{translateUi('Confirm: {value}?', { value: label.toLowerCase() })}</span>
      <button
        disabled={disabled}
        onClick={() => {
          setConfirm(false);
          onConfirm();
        }}
      >
        {translateUi('Confirm')}
      </button>
      <button onClick={() => setConfirm(false)}>{translateUi('Back')}</button>
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
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  return (
    <article className="payment-record">
      <div>
        <strong>{p.orderNumber ?? p.id}</strong>
        <span className="payment-status">
          {translateUi(
            (
              {
                CREATED: 'Awaiting payment',
                HELD: 'Awaiting payout',
                PAYOUT_IN_PROGRESS: 'Payout in progress',
                PAYMENT_SUBMITTED: 'Awaiting confirmation',
                COMPLETED: 'Completed',
                CANCELLED: 'Cancelled',
                EXPIRED: 'Expired',
                DISPUTED: 'Under review',
              } as Record<string, string>
            )[p.status] ?? p.status.replaceAll('_', ' ')
          )}
        </span>
      </div>
      <p>
        {translateUi('Wallet {value} · Payment {value2}', {
          value: formatEtb(p.coinAmount),
          value2: formatMinor(p.fiatAmount, p.fiatCurrency, p.pricingSnapshot?.minorDigits),
        })}
      </p>
      {p.pricingSnapshot && (
        <p>
          {translateUi('USD 1 = {localPerUsd} {fiatCurrency} · fee {value} · rate {value2}', {
            localPerUsd: p.pricingSnapshot.localPerUsd,
            fiatCurrency: p.fiatCurrency,
            value: formatMinor(
              p.pricingSnapshot.feeMinor,
              p.fiatCurrency,
              p.pricingSnapshot.minorDigits
            ),
            value2: new Date(p.pricingSnapshot.observedAt).toLocaleString(interfaceLocale),
          })}
        </p>
      )}
      <time>{new Date(p.createdAt).toLocaleString(interfaceLocale)}</time>
      {p.paymentSnapshot && (
        <details open={p.status === 'CREATED'}>
          <summary>{translateUi('Payment details')}</summary>
          <dl>
            {Object.entries(p.paymentSnapshot).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll('_', ' ')}</dt>
                <dd>
                  {typeof value === 'string'
                    ? value
                    : translateUi('Contact support for this detail')}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <div className="payment-actions">{children}</div>
    </article>
  );
}
