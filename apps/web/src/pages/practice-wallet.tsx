import { formatEtb } from '@/lib/payment-money';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { GiftCollectionSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { PaymentNavigation, WalletQuickActions } from './wallet-navigation';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function PracticeWalletPage() {
  const { t: translateUi, locale: interfaceLocale } = useInterfaceLanguage();

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
        <p className="wallet-eyebrow">{translateUi('SALEM BET · WALLET')}</p>
        <h1>{translateUi('Your wallet')}</h1>
        <p>{translateUi('Deposit, withdraw and follow your payments.')}</p>
      </header>
      <PaymentNavigation />
      <section className="wallet-balance-card" aria-label={translateUi('Payment balance')}>
        <h2>{translateUi('Payment balance')}</h2>
        <p className="wallet-balance-value">
          {payments.data ? formatEtb(payments.data.coinsBalance) : '—'}
        </p>
        {payments.isPending && <p role="status">{translateUi('Loading payment balance…')}</p>}
        {payments.isError && (
          <div role="alert">
            <p>{translateUi('Could not load your payment balance.')}</p>
            <button onClick={() => void payments.refetch()}>
              {translateUi('Retry payment balance')}
            </button>
          </div>
        )}
        {payments.data?.coinAvailability && (
          <p>
            {translateUi('{value} available · withdrawal eligibility applies', {
              value: formatEtb(payments.data.coinAvailability.spendable),
            })}
          </p>
        )}
        <p>
          {translateUi(
            'One wallet in Birr (ETB). Deposit through an agent or send USDT on TRON and receive ETB at the quoted rate.'
          )}
        </p>
      </section>
      <WalletQuickActions />
      <p>
        {translateUi(
          'Choose Agent or Crypto inside either option. Availability and any setup needed are shown there.'
        )}
      </p>
      <section className="wallet-info-card" aria-label={translateUi('Gift practice balance')}>
        <h2>{translateUi('Practice gift balance')}</h2>
        <p className="wallet-balance-value">
          {gifts.data ? gifts.data.balance.toLocaleString(interfaceLocale) : '—'}{' '}
          <span>{translateUi('practice ETB')}</span>
        </p>
        {gifts.isPending && <p role="status">{translateUi('Loading gift balance…')}</p>}
        {gifts.isError && (
          <div role="alert">
            <p>{translateUi('Could not load your gift balance.')}</p>
            <button onClick={() => void gifts.refetch()}>
              {translateUi('Retry gift balance')}
            </button>
          </div>
        )}
        <p>
          {translateUi(
            'Virtual ETB with no cash value. Practice gifts and game balances cannot be withdrawn.'
          )}
        </p>
        <Link to="/gifts">{translateUi('Open gift shop →')}</Link>
      </section>
      <div className="wallet-help-grid">
        <section className="wallet-info-card">
          <h2>{translateUi('Payment history')}</h2>
          <p>
            {translateUi(
              'Check your deposit instructions, withdrawal status and completed requests.'
            )}
          </p>
          <Link to="/wallet/activity">{translateUi('View payment activity →')}</Link>
        </section>
        <section className="wallet-info-card">
          <h2>{translateUi('Practice games')}</h2>
          <p>{translateUi('Each game keeps its own practice balance or round limit.')}</p>
          <Link to="/games">{translateUi('Play our games →')}</Link>
        </section>
      </div>
    </section>
  );
}
