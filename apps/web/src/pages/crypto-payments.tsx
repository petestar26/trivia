import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PaymentMethodChooser, PaymentSteps, paymentPath } from './wallet-navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import './crypto-payments.css';
import { formatEtb, inputToMinor } from '@/lib/payment-money';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

type ExchangeRate = {
  available: boolean;
  rateId?: string;
  localPerUsd?: string;
  observedAt?: string;
  expiresAt?: string;
  source?: string;
  cryptoDepositMinUsdCents?: number;
  cryptoWithdrawalAboveUsdCents?: number;
};

type Payment = {
  id: string;
  address: string;
  amount: string;
  coinAmount: number;
  rate?: ExchangeRate;
  status: string;
  createdAt: string;
  expiresAt?: string;
  reviewReason?: string;
  verificationDelayed?: boolean;
  txHash?: string;
  transfers?: {
    txHash: string;
    logIndex: number;
    amount: string;
    blockNumber: string;
    blockTime: string;
  }[];
  userId?: string;
  assignedAdminId?: string;
};
type Records = {
  deposits: Payment[];
  withdrawals: Payment[];
  addresses?: { address: string; label: string; used: boolean; retired: boolean }[];
};
type Options = {
  rate?: ExchangeRate;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
  depositUnavailableReason?: string | null;
  withdrawalUnavailableReason?: string | null;
  countries: { id: string; name: string }[];
};
export function timeRemaining(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function cryptoEstimate(value: string, withdraw = false, localPerUsd?: string) {
  try {
    if (!localPerUsd || !/^\d+(?:\.\d{1,8})?$/.test(localPerUsd)) return '';
    const [rw, rf = ''] = localPerUsd.split('.');
    const rate = BigInt(rw + rf),
      scale = 10n ** BigInt(rf.length);
    if (rate <= 0n) return '';
    if (withdraw) {
      const minor = inputToMinor(value, 2);
      if (!minor || minor > 1_000_000_000) return '';
      const n = (BigInt(minor) * 1_000_000n * scale) / (100n * rate);
      if (n <= 0n) return '';
      return `${n / 1_000_000n}.${String(n % 1_000_000n).padStart(6, '0')} USDT`;
    }
    if (!/^(?:0|[1-9]\d{0,7})(\.\d{1,6})?$/.test(value)) return '';
    const [w, f = ''] = value.split('.');
    const minor =
      ((BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'))) * rate * 100n) / (1_000_000n * scale);
    return minor > 0n && minor <= 1_000_000_000n ? formatEtb(minor.toString()) : '';
  } catch {
    return '';
  }
}
function CopyAddress({ address }: { address: string }) {
  const { t: translateUi } = useInterfaceLanguage();
  const [status, setStatus] = useState('Copy address');
  return (
    <div className="crypto-address">
      <code>{address}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setStatus('Copied');
          } catch {
            setStatus('Select and copy the address');
          }
        }}
      >
        {translateUi(status)}
      </button>
    </div>
  );
}
function PaymentCard({ payment, children }: { payment: Payment; children?: React.ReactNode }) {
  const { t: translateUi } = useInterfaceLanguage();

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!payment.expiresAt || payment.status !== 'WAITING') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [payment.expiresAt, payment.status]);
  const expired = payment.expiresAt && Date.parse(payment.expiresAt) <= now;
  return (
    <article className="crypto-record">
      <div className="crypto-row">
        <strong>{translateUi('{amount} USDT', { amount: payment.amount })}</strong>
        <span className={`crypto-status crypto-status-${payment.status.toLowerCase()}`}>
          {payment.status === 'WAITING'
            ? expired
              ? translateUi('Awaiting final check')
              : translateUi('Awaiting transfer')
            : interfaceCodeLabel(translateUi, payment.status)}
        </span>
      </div>
      <p>{translateUi('{value} · TRON (TRC20)', { value: formatEtb(payment.coinAmount) })}</p>
      {payment.rate?.localPerUsd && (
        <p>
          {translateUi('Locked rate: 1 USDT = {localPerUsd} ETB', {
            localPerUsd: payment.rate.localPerUsd,
          })}
        </p>
      )}
      <small>{translateUi('Request {id}', { id: payment.id })}</small>
      {payment.userId && <p>{translateUi('Member: {userId}', { userId: payment.userId })}</p>}
      {payment.expiresAt && payment.status === 'WAITING' && !expired && (
        <p className="crypto-timer">
          <strong>
            {translateUi('Transfer within {time}', { time: timeRemaining(payment.expiresAt, now) })}
          </strong>
        </p>
      )}
      <CopyAddress address={payment.address} />
      {payment.expiresAt && (
        <p>
          {payment.status === 'CREDITED'
            ? translateUi(
                'Your ETB balance has been credited. Do not send again or reuse this address.'
              )
            : payment.status === 'REVIEW'
              ? translateUi(
                  'This address is closed for new transfers. Your deposit needs support review.'
                )
              : expired
                ? translateUi(
                    'The transfer window has ended. Do not send to this address. On-time transfers may still be confirming.'
                  )
                : translateUi(
                    'Send the exact amount in a single transfer. Exchange and network fees must not reduce the amount received.'
                  )}
        </p>
      )}
      {payment.verificationDelayed && (
        <p role="status">
          {translateUi('Verification is delayed. Do not send again. We will keep checking.')}
        </p>
      )}
      {payment.reviewReason && (
        <p role="status">
          {translateUi(
            'This deposit needs support review. {reviewReason}. Keep your transfer receipt; do not send again.',
            { reviewReason: payment.reviewReason }
          )}
        </p>
      )}
      {payment.transfers?.map((t) => (
        <p key={`${t.txHash}:${t.logIndex}`}>
          {translateUi('Confirmed receipt:') + ' '}
          {t.amount}
          {' ' + translateUi('USDT · block') + ' '}
          {t.blockNumber} ·{' '}
          <a
            href={`https://tronscan.org/#/transaction/${t.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {translateUi('View deposit transfer')}
          </a>
        </p>
      ))}
      {payment.txHash && (
        <p>
          {translateUi('Transfer:')}{' '}
          <a
            href={`https://tronscan.org/#/transaction/${payment.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {translateUi('View on TRON explorer')}
          </a>
        </p>
      )}
      {children}
    </article>
  );
}
export function CryptoPaymentsPage({ admin = false }: { admin?: boolean }) {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

  const { user } = useAuth(),
    cache = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const direction = search.get('direction') === 'withdraw' ? 'withdrawal' : 'deposit';
  const [reviewed, setReviewed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [amount, setAmount] = useState(''),
    [countryId, setCountryId] = useState(''),
    [address, setAddress] = useState(''),
    [label, setLabel] = useState('');
  const [code, setCode] = useState(''),
    [txHash, setTxHash] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState<{ id: string; action: 'claim' | 'confirm' } | null>(null);
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const action = useWalletAction('crypto');
  useEffect(() => {
    setAmount('');
    setAddress('');
    setCode('');
    setReviewed(false);
  }, [direction]);
  const setDirection = (value: 'deposit' | 'withdrawal') =>
    setSearch(value === 'withdrawal' ? { direction: 'withdraw' } : { direction: 'deposit' });
  const formBlocked = busy || action.blocked;
  const records = useQuery({
    queryKey: ['payments', 'crypto', user?.id, admin, page],
    queryFn: async () =>
      unwrapData(await api.get<Records>(`/crypto-payments/${admin ? 'admin' : 'me'}?page=${page}`)),
    enabled: !!user,
    refetchInterval: 15000,
  });
  const opts = useQuery({
    queryKey: ['crypto-options', user?.id],
    queryFn: async () => unwrapData(await api.get<Options>('/crypto-payments/options')),
    enabled: !!user && !admin,
    refetchInterval: 60_000,
  });
  const rate = opts.data?.rate;
  const freshRate =
    rate?.available && !!rate.expiresAt && Date.parse(rate.expiresAt) > now ? rate : null;
  const estimate = cryptoEstimate(amount, direction === 'withdrawal', freshRate?.localPerUsd);
  useEffect(() => {
    setReviewed(false);
  }, [rate?.rateId]);
  const country = countryId || opts.data?.countries[0]?.id || '';
  const enabled =
    direction === 'deposit' ? opts.data?.depositEnabled : opts.data?.withdrawalEnabled;
  async function post(path: string, body: unknown = {}, purpose?: string) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      if (purpose) {
        await boundedRequest((signal) =>
          api.post('/security/step-up/verify', { purpose, factorType: 'TOTP', code }, undefined, {
            signal,
          })
        );
        setCode('');
      }
      await boundedRequest((signal) => api.post(path, body, undefined, { signal }));
      setMessage('Request confirmed. Records updated.');
      setSelected(null);
      setConfirmed(false);
      await cache.invalidateQueries({ queryKey: ['payments'] });
      await cache.invalidateQueries({ queryKey: ['wallet'] });
    } catch (e) {
      setMessage(walletError(e));
      await records.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={`crypto-page ${admin ? '' : 'crypto-member'}`}>
      <header>
        <Link to={admin ? '/admin' : '/wallet'}>
          ← {admin ? translateUi('Administration') : translateUi('Wallet')}
        </Link>
        <p className="crypto-eyebrow">{translateUi('USDT · TRON NETWORK')}</p>
        <h1>
          {admin
            ? translateUi('Crypto payments')
            : direction === 'deposit'
              ? translateUi('Deposit')
              : translateUi('Withdraw')}
        </h1>
        <p>
          {admin
            ? translateUi(
                'Manage receiving addresses, review deposits and complete manual withdrawals.'
              )
            : direction === 'deposit'
              ? translateUi('Add funds using USDT on TRON.')
              : translateUi('Receive USDT in your own TRON wallet.')}
        </p>
      </header>
      {!admin && (
        <>
          <div className="crypto-tabs" role="group" aria-label={translateUi('Payment direction')}>
            <button
              aria-pressed={direction === 'deposit'}
              onClick={() => {
                setDirection('deposit');
                setAmount('');
              }}
            >
              {translateUi('Deposit')}
            </button>
            <button
              aria-pressed={direction === 'withdrawal'}
              onClick={() => {
                setDirection('withdrawal');
                setAmount('');
              }}
            >
              {translateUi('Withdraw')}
            </button>
          </div>
          <PaymentMethodChooser
            direction={direction === 'deposit' ? 'deposit' : 'withdraw'}
            method="crypto"
          />
          <PaymentSteps
            direction={direction === 'deposit' ? 'deposit' : 'withdraw'}
            method="crypto"
          />
        </>
      )}
      <div className="crypto-notice">
        {admin
          ? translateUi(
              'Use USDT on TRON (TRC20) only. Verify transfers before completing a payout.'
            )
          : direction === 'deposit'
            ? translateUi(
                'Send USDT on TRON (TRC20) only. Your deposit is credited after the transfer is verified.'
              )
            : translateUi('USDT payouts use TRON (TRC20) and are processed by an administrator.')}
      </div>
      {!admin && (
        <section className="crypto-panel">
          {opts.isPending ? (
            <p>{translateUi('Loading payment availability…')}</p>
          ) : opts.isError ? (
            <p role="alert">
              {translateUi('Could not load availability.') + ' '}
              <button onClick={() => opts.refetch()}>{translateUi('Retry')}</button>
            </p>
          ) : (
            <>
              {!enabled && (
                <div role="status" className="crypto-paused">
                  <p>
                    {translateUi('New crypto {value} are paused.', {
                      value:
                        direction === 'deposit'
                          ? translateUi('deposits')
                          : translateUi('withdrawals'),
                    })}
                  </p>
                  <p>
                    {direction === 'deposit'
                      ? opts.data?.depositUnavailableReason
                      : opts.data?.withdrawalUnavailableReason}
                  </p>
                </div>
              )}
              {!opts.data?.countries.length && (
                <p>
                  {translateUi('Add an active payout account before requesting a payment.')}{' '}
                  <Link to="/wallet/withdraw">{translateUi('Add a payout account')}</Link>
                </p>
              )}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    !enabled ||
                    !country ||
                    formBlocked ||
                    !estimate ||
                    !freshRate?.rateId ||
                    (direction === 'withdrawal' &&
                      !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim()))
                  )
                    return;
                  if (!reviewed) {
                    setReviewed(true);
                    return;
                  }
                  setReviewed(false);
                  await action.run(
                    `/crypto-payments/${direction === 'deposit' ? 'deposits' : 'withdrawals'}`,
                    direction === 'deposit'
                      ? { countryId: country, amount, rateId: freshRate.rateId }
                      : {
                          countryId: country,
                          coinAmount: inputToMinor(amount, 2),
                          address: address.trim(),
                          rateId: freshRate.rateId,
                        }
                  );
                }}
              >
                <label>
                  {translateUi('Payment country')}
                  <select
                    aria-label={translateUi('Payment country')}
                    value={country}
                    disabled={formBlocked}
                    onChange={(e) => {
                      setCountryId(e.target.value);
                      setReviewed(false);
                    }}
                  >
                    {!country && <option value="">{translateUi('Select your country')}</option>}
                    {opts.data?.countries.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {direction === 'deposit'
                    ? translateUi('Deposit amount (USDT)')
                    : translateUi('Withdraw amount (ETB)')}
                  <input
                    inputMode="decimal"
                    value={amount}
                    disabled={formBlocked}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setReviewed(false);
                    }}
                    placeholder={direction === 'deposit' ? '10.000000' : '5000.00'}
                    required
                    pattern={
                      direction === 'deposit' ? '[0-9]+(\\.[0-9]{1,6})?' : '[0-9]+(\\.[0-9]{1,2})?'
                    }
                  />
                </label>
                <div className="crypto-quote">
                  <span>
                    {direction === 'deposit'
                      ? translateUi('You receive')
                      : translateUi('You receive at your address')}
                  </span>
                  <strong>{estimate || '—'}</strong>
                  {freshRate ? (
                    <>
                      <small>
                        {translateUi('1 USDT = {localPerUsd} ETB · No platform fee', {
                          localPerUsd: freshRate.localPerUsd ?? '',
                        })}
                      </small>
                      <small>
                        {direction === 'deposit'
                          ? translateUi('Minimum deposit: {value} USDT', {
                              value: (freshRate.cryptoDepositMinUsdCents! / 100).toFixed(2),
                            })
                          : translateUi('Withdrawal must exceed {value} USDT at this rate.', {
                              value: (freshRate.cryptoWithdrawalAboveUsdCents! / 100).toFixed(2),
                            })}
                      </small>
                      <details>
                        <summary>{translateUi('Exchange rate details')}</summary>
                        <small>
                          {translateUi(
                            'USD reference: {source}. Quoted at 1 USDT = USD 1. Amounts round down to 0.01 ETB or 0.000001 USDT.',
                            { source: 'EthioBlackMarket' }
                          )}{' '}
                          <a href="https://ethioblackmarket.com/" target="_blank" rel="noreferrer">
                            {translateUi('View source')}
                          </a>
                        </small>
                        <small>
                          {translateUi('Updated {value} · valid until {value2}', {
                            value: new Date(freshRate.observedAt!).toLocaleTimeString(
                              interfaceLocale
                            ),
                            value2: new Date(freshRate.expiresAt!).toLocaleTimeString(
                              interfaceLocale
                            ),
                          })}
                        </small>
                      </details>
                    </>
                  ) : (
                    <small>
                      {translateUi(
                        'A fresh exchange rate is unavailable. Please try again shortly.'
                      )}
                    </small>
                  )}
                </div>
                {direction === 'withdrawal' && (
                  <>
                    <label>
                      {translateUi('Your TRON receiving address')}
                      <input
                        value={address}
                        disabled={formBlocked}
                        onChange={(e) => {
                          setAddress(e.target.value);
                          setReviewed(false);
                        }}
                        autoComplete="off"
                        spellCheck={false}
                        required
                        placeholder={'T…'}
                        pattern="T[1-9A-HJ-NP-Za-km-z]{33}"
                      />
                    </label>
                    <p>
                      {translateUi(
                        'Use your own receiving address on TRON (TRC20). Your requested ETB balance is held while the payout is processed. Practice balances cannot be withdrawn.'
                      )}
                    </p>
                    <label>
                      {translateUi('Authenticator code (if required)')}
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                      />
                    </label>
                    {code && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await boundedRequest((signal) =>
                              api.post(
                                '/security/step-up/verify',
                                { purpose: 'CRYPTO_WITHDRAWAL_CREATE', factorType: 'TOTP', code },
                                undefined,
                                { signal }
                              )
                            );
                            setCode('');
                            setMessage('Identity check passed. You can submit the withdrawal.');
                          } catch (e) {
                            setMessage(walletError(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {translateUi('Verify identity')}
                      </button>
                    )}
                  </>
                )}
                {reviewed && direction === 'withdrawal' && (
                  <section className="crypto-quote" aria-label={translateUi('Review withdrawal')}>
                    <h2>{translateUi('Check your withdrawal')}</h2>
                    <p>
                      <strong>
                        {translateUi('You withdraw {amount} ETB and receive {estimate}.', {
                          amount,
                          estimate,
                        })}
                      </strong>
                    </p>
                    <p>{translateUi('Network: TRON (TRC20)')}</p>
                    <code className="crypto-review-address">{address.trim()}</code>
                    <p>
                      {translateUi(
                        'An administrator processes the payout. Check this receiving address before submitting.'
                      )}
                    </p>
                    <button type="button" onClick={() => setReviewed(false)}>
                      {translateUi('Back to editing')}
                    </button>
                  </section>
                )}
                {reviewed && direction === 'deposit' && (
                  <section className="crypto-quote" aria-label={translateUi('Review deposit')}>
                    <h2>{translateUi('Check your deposit')}</h2>
                    <p>
                      <strong>
                        {translateUi('Send {amount} USDT on TRON to receive {estimate}.', {
                          amount,
                          estimate,
                        })}
                      </strong>
                    </p>
                    <p>
                      {translateUi(
                        'The rate is locked when your deposit address is created. Send within the displayed time limit.'
                      )}
                    </p>
                    <button type="button" onClick={() => setReviewed(false)}>
                      {translateUi('Back to editing')}
                    </button>
                  </section>
                )}
                <button
                  className="crypto-primary"
                  disabled={
                    !enabled ||
                    !country ||
                    action.blocked ||
                    busy ||
                    !estimate ||
                    !freshRate?.rateId ||
                    (direction === 'withdrawal' &&
                      !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim()))
                  }
                >
                  {direction === 'deposit'
                    ? reviewed
                      ? translateUi('Get deposit address')
                      : translateUi('Review deposit')
                    : reviewed
                      ? translateUi('Request withdrawal')
                      : translateUi('Review withdrawal')}
                </button>
              </form>
            </>
          )}
          {action.message && <p role="status">{translateUi(action.message)}</p>}
          {action.pending && (
            <div>
              <p>
                {translateUi(
                  'One earlier {value} still needs confirmation. Retry sends exactly the saved details.',
                  {
                    value: action.pending.path.endsWith('/withdrawals')
                      ? translateUi('withdrawal')
                      : translateUi('deposit'),
                  }
                )}
              </p>
              <button
                disabled={action.busy}
                onClick={() => action.run(action.pending!.path, action.pending!.body)}
              >
                {translateUi('Retry the same request')}
              </button>
            </div>
          )}
        </section>
      )}
      {admin && (
        <section className="crypto-panel">
          <h2>{translateUi('Deposit address pool')}</h2>
          <p>
            {translateUi(
              'Each address is reserved permanently for one deposit request. Add a new, unused address that your organization controls. Never enter a private key or seed phrase.'
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void post(
                '/crypto-payments/admin/addresses',
                { address, label, unusedAddressConfirmed: confirmed },
                'CRYPTO_ADDRESS_ADD'
              );
            }}
          >
            <label>
              {translateUi('TRON address')}
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              {translateUi('Address label')}
              <input
                value={label}
                maxLength={100}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </label>
            <label className="crypto-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {translateUi('I control this unused receiving address.')}
            </label>
            <label>
              {translateUi('Authenticator code')}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </label>
            <button disabled={busy || !confirmed}>{translateUi('Add receiving address')}</button>
          </form>
          {records.data?.addresses?.map((a) => (
            <div key={a.address} className="crypto-record">
              <strong>
                {a.label} ·{' '}
                {a.retired
                  ? translateUi('Retired')
                  : a.used
                    ? translateUi('Reserved permanently')
                    : translateUi('Available')}
              </strong>
              <CopyAddress address={a.address} />
              {!a.retired && !a.used && (
                <button
                  disabled={busy}
                  onClick={() => post(`/crypto-payments/admin/addresses/${a.address}/retire`)}
                >
                  {translateUi('Retire address')}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {message && (
        <p role="status" className="crypto-notice">
          {translateUi(message)}
        </p>
      )}
      {selected && (
        <section className="crypto-panel">
          <h2>
            {selected.action === 'claim'
              ? translateUi('Take responsibility for manual payout')
              : translateUi('Confirm your completed transfer')}
          </h2>
          <p>
            {translateUi('Request {id}. {value}', {
              id: selected.id,
              value:
                selected.action === 'claim'
                  ? translateUi(
                      'After claiming, verify the address and amount, then transfer USDT from your external wallet. Cancellation will be unavailable.'
                    )
                  : translateUi(
                      'Confirm only after checking the successful transfer on TRON. This action completes the held ETB withdrawal.'
                    ),
            })}
          </p>
          <p className="crypto-warning">
            {translateUi(
              'Verify that the recipient controls the destination wallet. Never transfer a withdrawal to a platform deposit address, including a retired address.'
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void post(
                `/crypto-payments/admin/withdrawals/${selected.id}/${selected.action}`,
                selected.action === 'confirm' ? { txHash, transferred: confirmed } : {},
                `CRYPTO_WITHDRAWAL_${selected.action.toUpperCase()}:${selected.id}`
              );
            }}
          >
            {selected.action === 'confirm' && (
              <>
                <label>
                  {translateUi('TRON transaction hash')}
                  <input
                    required
                    pattern="[a-fA-F0-9]{64}"
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="crypto-check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {translateUi(
                    'I verified the successful transfer, receiving address, TRC20 network and exact amount.'
                  )}
                </label>
              </>
            )}
            <label>
              {translateUi('Authenticator code')}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </label>
            <button disabled={busy || (selected.action === 'confirm' && !confirmed)}>
              {selected.action === 'claim'
                ? translateUi('Claim manual payout')
                : translateUi('Confirm withdrawal')}
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(null)}>
              {translateUi('Close')}
            </button>
          </form>
        </section>
      )}
      {!admin && (
        <nav className="wallet-history-links" aria-label={translateUi('Other payment methods')}>
          <Link to={paymentPath(direction === 'deposit' ? 'deposit' : 'withdraw', 'agent')}>
            {translateUi('Use an agent instead')}
          </Link>
          <Link to="/wallet/activity">{translateUi('Agent payment activity')}</Link>
        </nav>
      )}
      <section className="crypto-panel">
        <h2>{admin ? translateUi('Payment queue') : translateUi('Your crypto requests')}</h2>
        <p>
          {translateUi('Page {value} · up to 50 of each request type. {value2}', {
            value: page + 1,
            value2: admin ? translateUi('Open requests appear first.') : '',
          })}
        </p>
        <div className="crypto-row">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            {translateUi('Previous page')}
          </button>
          <button
            disabled={
              !records.data ||
              Math.max(
                records.data.deposits.length,
                records.data.withdrawals.length,
                records.data.addresses?.length ?? 0
              ) < 50
            }
            onClick={() => setPage((p) => p + 1)}
          >
            {translateUi('Next page')}
          </button>
        </div>
        {records.isPending ? (
          <p>{translateUi('Loading requests…')}</p>
        ) : records.isError ? (
          <p role="alert">
            {translateUi('Could not load requests.') + ' '}
            <button onClick={() => records.refetch()}>{translateUi('Retry')}</button>
          </p>
        ) : (
          <div className="crypto-grid">
            <div>
              <h3>{translateUi('Deposits')}</h3>
              {!records.data?.deposits.length && <p>{translateUi('No deposit requests yet.')}</p>}
              {records.data?.deposits.map((p) => (
                <PaymentCard key={p.id} payment={p} />
              ))}
            </div>
            <div>
              <h3>{translateUi('Withdrawals')}</h3>
              {!records.data?.withdrawals.length && (
                <p>{translateUi('No withdrawal requests yet.')}</p>
              )}
              {records.data?.withdrawals.map((p) => (
                <PaymentCard key={p.id} payment={p}>
                  {p.status === 'HELD' && (
                    <div className="crypto-row">
                      {admin && p.userId !== user?.id && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setSelected({ id: p.id, action: 'claim' });
                            setCode('');
                            setConfirmed(false);
                          }}
                        >
                          {translateUi('Claim manual payout')}
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() =>
                          post(
                            `/crypto-payments/${admin ? 'admin/' : ''}withdrawals/${p.id}/cancel`
                          )
                        }
                      >
                        {translateUi('Cancel and return ETB')}
                      </button>
                    </div>
                  )}
                  {admin && p.status === 'PAYOUT_IN_PROGRESS' && p.assignedAdminId === user?.id && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSelected({ id: p.id, action: 'confirm' });
                        setTxHash('');
                        setCode('');
                        setConfirmed(false);
                      }}
                    >
                      {translateUi('Record completed transfer')}
                    </button>
                  )}
                </PaymentCard>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
