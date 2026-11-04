import { Link } from 'react-router-dom';

export function GameComingSoonPage({ name }: { name: string }) {
  return (
    <main className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-8 text-slate-100 sm:p-12">
      <p className="text-sm font-semibold uppercase tracking-widest text-amber-300">Coming soon</p>
      <h1 className="mt-3 text-3xl font-bold">{name}</h1>
      <p className="mt-4 text-slate-300">This game is being prepared. Explore our available games while you wait.</p>
      <Link
        to="/games"
        className="mt-6 inline-block rounded-lg bg-primary-600 px-5 py-3 font-semibold text-white hover:bg-primary-500"
      >
        Back to games
      </Link>
    </main>
  );
}
