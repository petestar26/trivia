import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { GiftCollectionSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';

export function PracticeWalletPage() {
  const { user } = useAuth();
  const wallet = useQuery({ queryKey: ['gift-collection', user?.id, 'wallet'],
    queryFn: async () => unwrapData(await api.get<GiftCollectionSnapshot>('/gift-collection')),
    enabled: !!user, refetchInterval: 10000 });
  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <header><p className="text-sm font-semibold text-violet-600">ETHIOPIAN BIRR · PRACTICE MODE</p>
      <h1 className="mt-2 text-3xl font-bold">Your practice wallet</h1>
      <p className="mt-3 text-gray-500">All amounts here are virtual ETB with no cash value. Deposits and withdrawals are unavailable in practice mode.</p></header>
    <section className="rounded-3xl border bg-white p-6 dark:bg-gray-900" aria-label="Gift practice balance">
      <h2 className="font-semibold">Gift balance</h2>
      <p className="my-4 text-4xl font-bold">{wallet.data ? wallet.data.balance.toLocaleString() : '—'} <span className="text-lg">practice ETB</span></p>
      {wallet.isLoading && <p role="status">Loading your balance…</p>}
      {wallet.isError && <div role="alert"><p>Could not load your gift balance.</p><Button onClick={() => void wallet.refetch()}>Retry</Button></div>}
      <p className="mb-5 text-sm text-gray-500">A one-time 10,000 virtual ETB starting balance. Gifts start at 500 ETB. Buying and sending are free of fees; conversion returns 90%.</p>
      <Link className="inline-block rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white" to="/gifts">Open gift shop</Link>
    </section>
    <section className="rounded-3xl border p-6"><h2 className="text-xl font-bold">Game balances</h2>
      <p className="my-3 text-gray-500">Each practice game keeps its own tickets and balance or per-round limit. Open a game to see its practice ETB rules. Game balances and gift balances cannot be transferred between one another.</p>
      <Link to="/games" className="font-semibold text-violet-600 underline">Play our games</Link></section>
    <p className="text-sm text-gray-500">Existing Coins and Game Points have not been converted to Birr. This practice wallet is separate from those records.</p>
  </main>;
}
