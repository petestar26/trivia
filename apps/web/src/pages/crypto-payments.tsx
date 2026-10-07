import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { useWalletAction, walletError } from '@/hooks/use-wallet-action';
import './crypto-payments.css';

type Payment = {
  id: string;
  address: string;
  amount: string;
  coinAmount: number;
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
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
  countries: { id: string; name: string }[];
};
export function timeRemaining(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function cryptoEstimate(value: string, withdraw = false) {
  try {
    if (withdraw) {
      if (!/^\d{1,10}$/.test(value)) return '';
      const n = (BigInt(value) * 1_000_000n) / 96n;
      return `${n / 1_000_000n}.${String(n % 1_000_000n).padStart(6, '0')} USDT`;
    }
    if (!/^\d{1,8}(\.\d{1,6})?$/.test(value)) return '';
    const [w, f = ''] = value.split('.');
    return `${((BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'))) * 96n) / 1_000_000n} Coins`;
  } catch {
    return '';
  }
}
function CopyAddress({ address }: { address: string }) {
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
        {status}
      </button>
    </div>
  );
}
function PaymentCard({ payment, children }: { payment: Payment; children?: React.ReactNode }) {
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
        <strong>{payment.amount} USDT</strong>
        <span className={`crypto-status crypto-status-${payment.status.toLowerCase()}`}>
          {payment.status === 'WAITING'
            ? expired
              ? 'Awaiting final check'
              : 'Awaiting transfer'
            : payment.status.replaceAll('_', ' ')}
        </span>
      </div>
      <p>{payment.coinAmount.toLocaleString()} Coins · TRON (TRC20)</p>
      <small>Request {payment.id}</small>
      {payment.userId && <p>Member: {payment.userId}</p>}
      {payment.expiresAt && payment.status === 'WAITING' && !expired && (
        <p className="crypto-timer">
          Transfer within <strong>{timeRemaining(payment.expiresAt, now)}</strong>
        </p>
      )}
      <CopyAddress address={payment.address} />
      {payment.expiresAt && (
        <p>
          {payment.status === 'CREDITED'
            ? 'Your Coins have been credited. Do not send again or reuse this address.'
            : payment.status === 'REVIEW'
              ? 'This address is closed for new transfers. Your deposit needs support review.'
              : expired
                ? 'The transfer window has ended. Do not send to this address. On-time transfers may still be confirming.'
                : 'Send the exact amount in a single transfer. Exchange and network fees must not reduce the amount received.'}
        </p>
      )}
      {payment.verificationDelayed && (
        <p role="status">Verification is delayed. Do not send again. We will keep checking.</p>
      )}
      {payment.reviewReason && (
        <p role="status">
          This deposit needs support review. {payment.reviewReason}. Keep your transfer receipt; do
          not send again.
        </p>
      )}
      {payment.transfers?.map((t) => (
        <p key={`${t.txHash}:${t.logIndex}`}>
          Confirmed receipt: {t.amount} USDT · block {t.blockNumber} ·{' '}
          <a
            href={`https://tronscan.org/#/transaction/${t.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View deposit transfer
          </a>
        </p>
      ))}
      {payment.txHash && (
        <p>
          Transfer:{' '}
          <a
            href={`https://tronscan.org/#/transaction/${payment.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View on TRON explorer
          </a>
        </p>
      )}
      {children}
    </article>
  );
}
export function CryptoPaymentsPage({ admin = false }: { admin?: boolean }) {
  const { user } = useAuth(),
    cache = useQueryClient();
  const [direction, setDirection] = useState<'deposit' | 'withdrawal'>('deposit');
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
  });
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
    <main className="crypto-page">
      <header>
        <Link to={admin ? '/admin' : '/wallet'}>← {admin ? 'Administration' : 'Wallet'}</Link>
        <p className="crypto-eyebrow">USDT · TRON NETWORK</p>
        <h1>{admin ? 'Crypto payments' : 'Your crypto wallet'}</h1>
        <p>
          {admin
            ? 'Manage receiving addresses, review deposits and complete manual withdrawals.'
            : 'Deposit USDT for Coins, or request a manual USDT withdrawal.'}
        </p>
      </header>
      <div className="crypto-notice">
        Use USDT on TRON (TRC20) only. Other tokens and networks cannot be credited. Deposits are
        credited after confirmed on-chain verification. Withdrawals are transferred by an
        administrator.
      </div>
      {!admin && (
        <section className="crypto-panel">
          <div className="crypto-tabs" aria-label="Payment direction">
            <button
              aria-pressed={direction === 'deposit'}
              onClick={() => {
                setDirection('deposit');
                setAmount('');
              }}
            >
              Deposit
            </button>
            <button
              aria-pressed={direction === 'withdrawal'}
              onClick={() => {
                setDirection('withdrawal');
                setAmount('');
              }}
            >
              Withdraw
            </button>
          </div>
          {opts.isPending ? (
            <p>Loading payment availability…</p>
          ) : opts.isError ? (
            <p role="alert">
              Could not load availability. <button onClick={() => opts.refetch()}>Retry</button>
            </p>
          ) : (
            <>
              {!enabled && (
                <p role="status" className="crypto-paused">
                  New crypto {direction === 'deposit' ? 'deposits' : 'withdrawals'} are paused.
                </p>
              )}
              {!opts.data?.countries.length && (
                <p>
                  Add an active payment profile in{' '}
                  <Link to="/wallet/withdraw">Wallet settings</Link> before requesting a payment.
                </p>
              )}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await action.run(
                    `/crypto-payments/${direction === 'deposit' ? 'deposits' : 'withdrawals'}`,
                    direction === 'deposit'
                      ? { countryId: country, amount }
                      : { countryId: country, coinAmount: Number(amount), address }
                  );
                }}
              >
                <label>
                  Payment country
                  <select
                    aria-label="Payment country"
                    value={country}
                    onChange={(e) => setCountryId(e.target.value)}
                  >
                    {!country && <option value="">Select your country</option>}
                    {opts.data?.countries.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {direction === 'deposit' ? 'Deposit amount (USDT)' : 'Withdraw amount (Coins)'}
                  <input
                    inputMode={direction === 'deposit' ? 'decimal' : 'numeric'}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={direction === 'deposit' ? '10.000000' : '2016'}
                    required
                    pattern={direction === 'deposit' ? '[0-9]+(\\.[0-9]{1,6})?' : '[0-9]+'}
                  />
                </label>
                <div className="crypto-quote">
                  <span>
                    {direction === 'deposit' ? 'You receive' : 'You receive at your address'}
                  </span>
                  <strong>{cryptoEstimate(amount, direction === 'withdrawal') || '—'}</strong>
                  <small>96 Coins = 1 USDT · No platform fee · Fractions round down</small>
                </div>
                {direction === 'withdrawal' && (
                  <>
                    <label>
                      Your TRON receiving address
                      <input
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        required
                        placeholder="T…"
                      />
                    </label>
                    <p>
                      Check every character. Only eligible Coins can be withdrawn. Coins are held
                      until your request is completed or cancelled.
                    </p>
                    <label>
                      Authenticator code (if required)
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
                        Verify identity
                      </button>
                    )}
                  </>
                )}
                <button
                  className="crypto-primary"
                  disabled={
                    !enabled ||
                    !country ||
                    action.blocked ||
                    busy ||
                    !cryptoEstimate(amount, direction === 'withdrawal')
                  }
                >
                  {direction === 'deposit' ? 'Get deposit address' : 'Request withdrawal'}
                </button>
              </form>
            </>
          )}
          {action.message && <p role="status">{action.message}</p>}
          {action.pending && (
            <button
              disabled={action.busy}
              onClick={() => action.run(action.pending!.path, action.pending!.body)}
            >
              Retry the same request
            </button>
          )}
        </section>
      )}
      {admin && (
        <section className="crypto-panel">
          <h2>Deposit address pool</h2>
          <p>
            Each address is reserved permanently for one deposit request. Add a new, unused address
            that your organization controls. Never enter a private key or seed phrase.
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
              TRON address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Address label
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
              I control this unused receiving address.
            </label>
            <label>
              Authenticator code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </label>
            <button disabled={busy || !confirmed}>Add receiving address</button>
          </form>
          {records.data?.addresses?.map((a) => (
            <div key={a.address} className="crypto-record">
              <strong>
                {a.label} · {a.retired ? 'Retired' : a.used ? 'Reserved permanently' : 'Available'}
              </strong>
              <CopyAddress address={a.address} />
              {!a.retired && !a.used && (
                <button
                  disabled={busy}
                  onClick={() => post(`/crypto-payments/admin/addresses/${a.address}/retire`)}
                >
                  Retire address
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      {message && (
        <p role="status" className="crypto-notice">
          {message}
        </p>
      )}
      {selected && (
        <section className="crypto-panel">
          <h2>
            {selected.action === 'claim'
              ? 'Take responsibility for manual payout'
              : 'Confirm your completed transfer'}
          </h2>
          <p>
            Request {selected.id}.{' '}
            {selected.action === 'claim'
              ? 'After claiming, verify the address and amount, then transfer USDT from your external wallet. Cancellation will be unavailable.'
              : 'Confirm only after checking the successful transfer on TRON. This action completes the held Coin withdrawal.'}
          </p>
          <p className="crypto-warning">
            Verify that the recipient controls the destination wallet. Never transfer a withdrawal
            to a platform deposit address, including a retired address.
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
                  TRON transaction hash
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
                  I verified the successful transfer, receiving address, TRC20 network and exact
                  amount.
                </label>
              </>
            )}
            <label>
              Authenticator code
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
              {selected.action === 'claim' ? 'Claim manual payout' : 'Confirm withdrawal'}
            </button>
            <button type="button" disabled={busy} onClick={() => setSelected(null)}>
              Close
            </button>
          </form>
        </section>
      )}
      <section className="crypto-panel">
        <h2>{admin ? 'Payment queue' : 'Your requests'}</h2>
        <p>
          Page {page + 1} · up to 50 of each request type.{' '}
          {admin ? 'Open requests appear first.' : ''}
        </p>
        <div className="crypto-row">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous page
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
            Next page
          </button>
        </div>
        {records.isPending ? (
          <p>Loading requests…</p>
        ) : records.isError ? (
          <p role="alert">
            Could not load requests. <button onClick={() => records.refetch()}>Retry</button>
          </p>
        ) : (
          <div className="crypto-grid">
            <div>
              <h3>Deposits</h3>
              {!records.data?.deposits.length && <p>No deposit requests yet.</p>}
              {records.data?.deposits.map((p) => (
                <PaymentCard key={p.id} payment={p} />
              ))}
            </div>
            <div>
              <h3>Withdrawals</h3>
              {!records.data?.withdrawals.length && <p>No withdrawal requests yet.</p>}
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
                          Claim manual payout
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
                        Cancel and return Coins
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
                      Record completed transfer
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
