import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpRight,
  CircleDot,
  RefreshCw,
  ShieldCheck,
  Trophy,
  Wallet,
} from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { formatEtb } from '@/lib/payment-money';
import { useAuth } from '@/providers/auth-provider';
import './sports.css';

interface SportsStatus {
  balanceMinor: number;
  rewardBalanceMinor: number;
  currency: 'ETB';
  mode: 'real-wallet';
  browseReady: boolean;
  liveEnabled: boolean;
  canBet: boolean;
  reason: 'not-live' | 'empty-wallet' | 'account-unavailable' | null;
}
interface Movement {
  id: string;
  action: 'debit' | 'credit';
  amountMinor: number;
  balanceMinor: number;
  rollback: boolean;
  createdAt: string;
}
export function SportsPage() {
  const { user } = useAuth();
  return user ? <SportsSession key={user.id} userId={user.id} /> : <p>Sign in to browse sports.</p>;
}
function SportsSession({ userId }: { userId: string }) {
  const status = useQuery({
    queryKey: ['sports-status', userId],
    retry: false,
    refetchInterval: 10000,
    queryFn: async () => unwrapData(await api.get<SportsStatus>('/sportsbook/status')),
  });
  const activity = useQuery({
    queryKey: ['sports-activity', userId],
    retry: false,
    refetchInterval: 15000,
    queryFn: async () => unwrapData(await api.get<Movement[]>('/sportsbook/activity')),
  });
  const ready =
    status.data?.browseReady === true && !status.isError && status.data.mode === 'real-wallet';
  const s = status.data;
  const notice = !s
    ? ''
    : s.reason === 'not-live'
      ? 'Browse the matches now. Betting opens when real-money play is available and your wallet has funds.'
      : s.reason === 'account-unavailable'
        ? 'You can browse sports. Betting is not currently available for your account.'
        : !s.canBet
          ? 'Your real wallet is empty. Add funds to place a bet; you can still browse the matches.'
          : 'Your available Birr balance is ready. Each bet is checked against your current funds.';
  const refresh = () => {
    void status.refetch();
    void activity.refetch();
  };
  return (
    <section className="salem-sports" aria-labelledby="sports-title">
      <div className="sports-topline">
        <Link to="/casino">
          <ArrowLeft size={15} /> Casino
        </Link>
        <span>
          <ShieldCheck size={15} /> Real wallet · Birr
        </span>
      </div>
      <header className="sports-heading">
        <div>
          <p className="sports-eyebrow">SALEM BET SPORTS</p>
          <h1 id="sports-title">
            Every match.
            <br />
            <em>Your moment.</em>
          </h1>
          <p>The fixtures, the markets, the action. All in one place.</p>
        </div>
        <section className="sports-wallet" aria-label="Sports real wallet">
          <Wallet size={24} />
          <span>Available real balance</span>
          <strong>
            {status.isPending
              ? 'Loading…'
              : status.isError
                ? 'Unavailable'
                : formatEtb(s?.balanceMinor)}
          </strong>
          <Link to="/wallet">
            Open wallet <ArrowUpRight size={15} />
          </Link>
          <small>Sports uses cash balance. Practice money and rewards stay separate.</small>
        </section>
      </header>
      {status.isError ? (
        <div className="sports-notice is-error" role="alert">
          <p>Your wallet could not be checked. Please refresh before opening sports.</p>
          <button onClick={refresh}>
            <RefreshCw size={16} /> Try again
          </button>
        </div>
      ) : (
        s && (
          <div className="sports-notice" role="status">
            <CircleDot size={19} />
            <p>{notice}</p>
            <button aria-label="Refresh sports balance" onClick={refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
        )
      )}
      <section className="sports-feature" aria-labelledby="sports-browse-title">
        <div className="sports-feature-copy">
          <span className="sports-provider">
            <Trophy size={17} /> NOCTURN SPORT
          </span>
          <h2 id="sports-browse-title">
            The game starts
            <br />
            with the fixtures.
          </h2>
          <p>Explore the sportsbook and choose your markets. Your wallet stays with Salem Bet.</p>
          {ready ? (
            <Link
              className="sports-open"
              to="/sports/open"
              target="_blank"
              rel="noopener noreferrer"
            >
              Browse sports <ArrowUpRight size={19} />
            </Link>
          ) : (
            <button className="sports-open" disabled>
              Browse sports <ArrowUpRight size={19} />
            </button>
          )}
          <p className="sports-open-hint">Opens in a new tab. Your wallet stays here.</p>
          {!status.isPending && !status.isError && !ready && (
            <p className="sports-availability">
              Sports is getting ready. Please check back shortly.
            </p>
          )}
        </div>
        <div className="sports-pitch" aria-hidden="true">
          <div className="sports-pitch-lines">
            <i />
            <b />
            <span />
          </div>
          <div className="sports-ball">
            <CircleDot strokeWidth={1} />
          </div>
          <p>ONE WALLET. A WORLD OF SPORT.</p>
        </div>
      </section>
      <section className="sports-history" aria-labelledby="sports-history-title">
        <div>
          <h2 id="sports-history-title">Wallet activity</h2>
          <Link to="/wallet">
            All transactions <ArrowUpRight size={15} />
          </Link>
        </div>
        {activity.isPending ? (
          <p>Loading your sports activity…</p>
        ) : activity.isError ? (
          <p role="alert">
            Activity could not be loaded.{' '}
            <button onClick={() => void activity.refetch()}>Try again</button>
          </p>
        ) : !activity.data?.length ? (
          <p>No sports transactions yet. Stakes, payouts, and refunds will appear here.</p>
        ) : (
          <ul>
            {activity.data.map((m) => (
              <li key={m.id}>
                <span>
                  <strong>
                    {m.rollback
                      ? 'Sports adjustment'
                      : m.action === 'debit'
                        ? 'Sports stake'
                        : 'Sports payout / refund'}
                  </strong>
                  <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</time>
                </span>
                <b data-credit={m.action === 'credit'}>
                  {m.action === 'credit' ? '+' : '−'}
                  {formatEtb(m.amountMinor)}
                </b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
