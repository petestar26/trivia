import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { GiftCollectionSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import {
  PaymentNavigation,
  PaymentMethodChooser,
  PaymentSteps,
  WalletQuickActions,
} from './wallet-navigation';

export function PracticeWalletPage() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  const method = pathname === '/wallet/crypto' ? 'crypto' : 'agent';
  const direction =
    pathname === '/wallet/withdraw' ||
    (method === 'crypto' && new URLSearchParams(search).get('direction') === 'withdraw')
      ? 'withdraw'
      : 'deposit';
  const payment = ['/wallet/deposit', '/wallet/withdraw', '/wallet/crypto'].includes(pathname);
  const activity = pathname === '/wallet/activity';
  const wallet = useQuery({
    queryKey: ['gift-collection', user?.id, 'wallet'],
    queryFn: async () => unwrapData(await api.get<GiftCollectionSnapshot>('/gift-collection')),
    enabled: !!user,
    refetchInterval: 10000,
  });
  return (
    <section className="wallet-simple">
      <header>
        <p className="wallet-eyebrow">SALEM BET · PRACTICE MODE</p>
        <h1>
          {payment
            ? direction === 'deposit'
              ? 'Deposit'
              : 'Withdraw'
            : activity
              ? 'Wallet activity'
              : 'Your wallet'}
        </h1>
        <p>
          {payment
            ? 'Choose a payment method below.'
            : 'Your balance and payment options, in one place.'}
        </p>
      </header>
      <PaymentNavigation method={method} />
      {payment ? (
        <>
          <PaymentMethodChooser direction={direction} method={method} />
          <div className="wallet-mode-notice" role="status">
            <strong>
              {direction === 'deposit' ? 'Deposits' : 'Withdrawals'} are unavailable in practice
              mode
            </strong>
            <p>
              Your balance is virtual ETB with no cash value.{' '}
              {method === 'crypto'
                ? 'No crypto payment address is issued here.'
                : 'No agent payment is requested here.'}
            </p>
          </div>
          <section className="wallet-info-card">
            <h2>
              {method === 'agent' ? 'Agent' : 'Crypto'}{' '}
              {direction === 'deposit' ? 'deposit' : 'withdrawal'} · how it will work
            </h2>
            <PaymentSteps direction={direction} method={method} />
            <p>
              {method === 'agent'
                ? 'When payments are enabled, available bank and mobile-money methods will appear for your country. Follow the instructions on your request.'
                : 'The existing crypto flow supports USDT on TRON (TRC20). Other coins and networks are not offered.'}
            </p>
            <Link to="/wallet">Back to your balance →</Link>
          </section>
        </>
      ) : (
        <>
          <section className="wallet-balance-card" aria-label="Gift practice balance">
            <h2>Gift balance</h2>
            <p className="wallet-balance-value">
              {wallet.data ? wallet.data.balance.toLocaleString() : '—'} <span>practice ETB</span>
            </p>
            {wallet.isLoading && <p role="status">Loading your balance…</p>}
            {wallet.isError && (
              <div role="alert">
                <p>Could not load your gift balance.</p>
                <button onClick={() => void wallet.refetch()}>Retry</button>
              </div>
            )}
            <p>Virtual ETB with no cash value. This balance is for practice gifts.</p>
          </section>
          <WalletQuickActions />
          <div className="wallet-mode-notice">
            <strong>Practice mode is active</strong>
            <p>
              Agent and crypto deposits and withdrawals are currently unavailable. Open either
              option to see how it works.
            </p>
          </div>
          {activity && (
            <section className="wallet-info-card">
              <h2>Where to find your activity</h2>
              <p>
                View your gift collection in the gift shop and game tickets inside each game.
                Cash-payment history is not shown in practice mode.
              </p>
              <Link to="/gifts">Open gift shop</Link>
            </section>
          )}
          <div className="wallet-help-grid">
            {!activity && (
              <section className="wallet-info-card">
                <h2>Gifts</h2>
                <p>
                  Gifts start at 500 ETB. Buying and sending have no fee. Converting a gift returns
                  90% of its value.
                </p>
                <Link to="/gifts">Open gift shop →</Link>
              </section>
            )}
            <section className="wallet-info-card">
              <h2>Game balances</h2>
              <p>
                Each practice game has its own balance or round limit. Check your balance and
                tickets inside the game.
              </p>
              <Link to="/games">Play our games →</Link>
            </section>
          </div>
          <details>
            <summary>About practice balances</summary>
            <p>
              Your gift wallet starts once with 10,000 virtual ETB. Game and gift balances cannot be
              transferred between one another. Existing Coins and Game Points have not been
              converted to Birr.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
