import { interfaceCodeLabel } from '@/lib/i18n/labels';
import { useState } from 'react';
import { PaymentNavigation, WalletQuickActions } from './wallet-navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';
import { LoadingState } from '@/components/ui/loading-state';

/**
 * Shape this page renders from `GET /wallet/transactions`. The API wraps the
 * list under `data` and puts paging under `meta`; `api.getWalletTransactions()`
 * already resolves to the array via `.data` in the queryFn, so the render path
 * consumes it as-is (no second `.data` access).
 */
interface WalletTransaction {
  id: string;
  type: string;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string;
  referenceId: string | null;
  description: string;
  createdAt: string;
}

export function WalletPage() {
  const {
    t: translateUi,
    locale: interfaceLocale,
    formatNumber,
    formatMinorCurrency: formatEtb,
  } = useInterfaceLanguage();

  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState<'coins' | 'gamePoints' | undefined>();
  const {
    data: wallet,
    isLoading: walletLoading,
    isError: walletError,
    refetch: refetchWallet,
  } = useQuery<any>({
    queryKey: ['wallet'],
    queryFn: async () => (await api.getWallet()).data,
  });

  const {
    data: transactions = [],
    isLoading: txLoading,
    isError: txError,
    refetch: refetchTransactions,
  } = useQuery<WalletTransaction[]>({
    queryKey: ['wallet-transactions', page, currency],
    queryFn: async () =>
      (await api.getWalletTransactions({ limit: 20, page, currency })).data ?? [],
  });

  const loading = walletLoading || txLoading;
  const error = walletError || txError;

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-red-600 dark:text-red-400">
            {translateUi('Failed to load wallet.') + ' '}
            <button
              className="ml-3 underline"
              onClick={() => {
                void refetchWallet();
                void refetchTransactions();
              }}
            >
              {translateUi('Retry')}
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const coins = wallet?.coinsBalance ?? 0;
  const gamePoints = wallet?.gamePointsBalance ?? 0;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{translateUi('Wallet')}</h1>
      <PaymentNavigation />
      <WalletQuickActions />

      {/* Balance cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 dark:text-gray-400">
              {translateUi('Birr (ETB)')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">
              {formatEtb(coins)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-500 dark:text-gray-400">
              {translateUi('Game Points')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-primary-600 dark:text-primary-400">
              {formatNumber(gamePoints)}
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/40">
        <h2 className="font-semibold">{translateUi('Know your Birr balance')}</h2>
        {wallet?.coinAvailability && (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              ['Available balance', wallet.coinAvailability.spendable],
              ['Bet-only rewards', wallet.coinAvailability.betOnly],
              ['Pending review / expiry', wallet.coinAvailability.pendingReview],
            ].map(([label, amount]) => (
              <div key={label}>
                <dt className="text-xs text-gray-500">{translateUi(String(label))}</dt>
                <dd className="mt-1 text-xl font-bold">{formatEtb(amount as number)}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">
          {translateUi(
            'Bonus balance can fund eligible bets. They cannot buy gifts, be transferred, or be cashed out. Under the new reward rule, only your net winnings become spendable; the returned free stake stays bet-only. Earlier grants retain their original terms.'
          )}
        </p>
        <p className="mt-2 text-xs text-gray-500">
          {translateUi(
            'Withdrawals still require account and country eligibility. Game Points and free practice credits are separate from your Birr balance.'
          )}
        </p>
      </section>

      <label className="block text-sm font-medium">
        {translateUi('Transaction currency')}
        <select
          className="ml-3 rounded-lg border p-2 dark:bg-gray-800"
          value={currency ?? ''}
          onChange={(e) => {
            setCurrency((e.target.value || undefined) as 'coins' | 'gamePoints' | undefined);
            setPage(1);
          }}
        >
          <option value="">{translateUi('All currencies')}</option>
          <option value="coins">{translateUi('Birr (ETB)')}</option>
          <option value="gamePoints">{translateUi('Game Points')}</option>
        </select>
      </label>
      {/* Transaction history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{translateUi('Transaction History')}</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
              {page === 1
                ? translateUi('No transactions yet.')
                : translateUi('No transactions on this page.')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 pr-4 text-left text-gray-500">{translateUi('Type')}</th>
                    <th className="py-2 pr-4 text-left text-gray-500">{translateUi('Currency')}</th>
                    <th className="py-2 pr-4 text-right text-gray-500">{translateUi('Amount')}</th>
                    <th className="py-2 text-right text-gray-500">{translateUi('Date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => {
                    // The API stores `amount` as a positive magnitude and does
                    // not return `ledgerType`; direction is derived from the
                    // authoritative before/after balances.
                    const delta = tx.balanceAfter - tx.balanceBefore;
                    const isCredit = delta > 0;
                    const isDebit = delta < 0;
                    const sign = isCredit ? '+' : isDebit ? '−' : '';
                    const amountClass = isCredit
                      ? 'text-green-600 dark:text-green-400'
                      : isDebit
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-600 dark:text-gray-400';
                    return (
                      <tr key={tx.id} className="border-b border-gray-100 dark:border-gray-800">
                        <td className="py-2 pr-4 font-medium">
                          {interfaceCodeLabel(
                            translateUi,
                            tx.type.replace('COIN_CREDIT', 'Credit').replace('COIN_DEBIT', 'Debit')
                          )}
                        </td>
                        <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">
                          {tx.currency === 'GAME_POINTS' ? translateUi('Game Points') : tx.currency}
                        </td>
                        <td className={`py-2 pr-4 text-right font-semibold ${amountClass}`}>
                          {sign}
                          {tx.currency === 'ETB' || tx.currency === 'COINS'
                            ? formatEtb(tx.amount)
                            : formatNumber(tx.amount)}
                        </td>
                        <td className="py-2 text-right text-gray-500 text-xs">
                          {new Date(tx.createdAt).toLocaleDateString(interfaceLocale)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <nav
        aria-label={translateUi('Transaction pages')}
        className="flex items-center justify-between gap-4"
      >
        <button
          disabled={page === 1}
          onClick={() => setPage((p) => p - 1)}
          className="rounded-lg border px-4 py-2 disabled:opacity-40"
        >
          {translateUi('Previous')}
        </button>
        <span>{translateUi('Page {page}', { page: page })}</span>
        <button
          disabled={transactions.length < 20}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-lg border px-4 py-2 disabled:opacity-40"
        >
          {translateUi('Next')}
        </button>
      </nav>
    </div>
  );
}
