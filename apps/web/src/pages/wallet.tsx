import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export function WalletPage() {
  const { data: wallet, isLoading: walletLoading, isError: walletError } = useQuery({
    queryKey: ['wallet'],
    queryFn: async () => (await api.getWallet()).data,
  });

  const { data: txData, isLoading: txLoading, isError: txError } = useQuery({
    queryKey: ['wallet-transactions'],
    queryFn: async () => (await api.getWalletTransactions({ limit: 50 })).data,
  });

  const loading = walletLoading || txLoading;
  const error = walletError || txError;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card><CardContent className="py-8 text-center text-red-600 dark:text-red-400">Failed to load wallet.</CardContent></Card>
      </div>
    );
  }

  const transactions = txData?.data ?? [];
  const coins = wallet?.coinsBalance ?? 0;
  const gamePoints = wallet?.gamePointsBalance ?? 0;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Wallet</h1>

      {/* Balance cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500 dark:text-gray-400">Coins</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-amber-600 dark:text-amber-400">{coins}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-gray-500 dark:text-gray-400">Game Points</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-primary-600 dark:text-primary-400">{gamePoints}</p></CardContent>
        </Card>
      </div>

      {/* Transaction history */}
      <Card>
        <CardHeader><CardTitle className="text-base">Transaction History</CardTitle></CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">No transactions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 pr-4 text-left text-gray-500">Type</th>
                    <th className="py-2 pr-4 text-left text-gray-500">Currency</th>
                    <th className="py-2 pr-4 text-right text-gray-500">Amount</th>
                    <th className="py-2 text-right text-gray-500">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx: any) => (
                    <tr key={tx.id} className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-2 pr-4 font-medium">{tx.type}</td>
                      <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">{tx.currency}</td>
                      <td className={`py-2 pr-4 text-right font-semibold ${tx.ledgerType === 'CREDIT' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {tx.ledgerType === 'CREDIT' ? '+' : '−'}{tx.amount}
                      </td>
                      <td className="py-2 text-right text-gray-500 text-xs">{new Date(tx.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
