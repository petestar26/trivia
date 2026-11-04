import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { GiftCollectionSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { PaymentNavigation, WalletQuickActions } from './wallet-navigation';

export function PracticeWalletPage() {
  const { user } = useAuth();
  const gifts = useQuery({
    queryKey: ['gift-collection', user?.id, 'wallet'],
    queryFn: async () => unwrapData(await api.get<GiftCollectionSnapshot>('/gift-collection')),
    enabled: !!user,
    refetchInterval: 10000,
  });
  const payments = useQuery({
    queryKey: ['wallet', user?.id],
    queryFn: async () =>
      unwrapData(
        await api.get<{
          coinsBalance: number;
          coinAvailability?: { spendable: number; betOnly: number };
        }>('/wallet')
      ),
    enabled: !!user,
    refetchInterval: 15000,
  });
  return (
    <section className="wallet-simple">
      <header>
        <p className="wallet-eyebrow">SALEM BET · WALLET</p>
        <h1>Your wallet</h1>
        <p>Deposit, withdraw and follow your payments.</p>
      </header>
      <PaymentNavigation />
      <section className="wallet-balance-card" aria-label="Payment balance">
        <h2>Payment balance</h2>
        <p className="wallet-balance-value">
          {payments.data ? payments.data.coinsBalance.toLocaleString() : '—'} <span>Coins</span>
        </p>
        {payments.isPending && <p role="status">Loading payment balance…</p>}
        {payments.isError && (
          <div role="alert">
            <p>Could not load your payment balance.</p>
            <button onClick={() => void payments.refetch()}>Retry payment balance</button>
          </div>
        )}
        {payments.data?.coinAvailability && (
          <p>
            {payments.data.coinAvailability.spendable.toLocaleString()} spendable Coins · withdrawal
            eligibility applies
          </p>
        )}
        <p>
          Agent payments use your country’s currency, including Birr (ETB). Crypto uses USDT on
          TRON. Review the conversion before confirming.
        </p>
      </section>
      <WalletQuickActions />
      <p>
        Choose Agent or Crypto inside either option. Availability and any setup needed are shown
        there.
      </p>
      <section className="wallet-info-card" aria-label="Gift practice balance">
        <h2>Practice gift balance</h2>
        <p className="wallet-balance-value">
          {gifts.data ? gifts.data.balance.toLocaleString() : '—'} <span>practice ETB</span>
        </p>
        {gifts.isPending && <p role="status">Loading gift balance…</p>}
        {gifts.isError && (
          <div role="alert">
            <p>Could not load your gift balance.</p>
            <button onClick={() => void gifts.refetch()}>Retry gift balance</button>
          </div>
        )}
        <p>Virtual ETB with no cash value. Practice gifts and game balances cannot be withdrawn.</p>
        <Link to="/gifts">Open gift shop →</Link>
      </section>
      <div className="wallet-help-grid">
        <section className="wallet-info-card">
          <h2>Payment history</h2>
          <p>Check your deposit instructions, withdrawal status and completed requests.</p>
          <Link to="/wallet/activity">View payment activity →</Link>
        </section>
        <section className="wallet-info-card">
          <h2>Practice games</h2>
          <p>Each game keeps its own practice balance or round limit.</p>
          <Link to="/games">Play our games →</Link>
        </section>
      </div>
    </section>
  );
}
