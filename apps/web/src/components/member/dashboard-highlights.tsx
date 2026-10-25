import { useState, useSyncExternalStore, useRef, useCallback } from 'react';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Award,
  Clock3,
  Gem,
  History,
  RefreshCw,
  ShieldCheck,
  Trophy,
} from 'lucide-react';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { parseDashboardReturns, topDashboardReturns } from '@/lib/dashboard-returns';
import { memberGameDestination, type MemberGame } from '@/lib/member-game-catalog';

const feeds = [
  { key: 'sky_crash', name: 'Sky Crash', endpoint: '/games/sky-crash/leaderboard' },
  { key: 'crash_point', name: 'Crash Point', endpoint: '/games/crash-point/leaderboard' },
] as const;
const credits = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

interface DashboardHighlightsProps {
  userId?: string;
  games: MemberGame[];
  catalogState: 'loading' | 'error' | 'ready';
}

/** Read-only display of existing public practice receipts. No prize or entry logic lives here. */
export function DashboardHighlights({ userId, games, catalogState }: DashboardHighlightsProps) {
  const [selectedGame, setSelectedGame] = useState<string>('sky_crash');
  const disconnectGeneration = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onlineManager.subscribe((online) => {
        if (!online) disconnectGeneration.current += 1;
        notify();
      }),
    []
  );
  const connection = useSyncExternalStore(
    subscribe,
    () => `${disconnectGeneration.current}:${onlineManager.isOnline()}`,
    () => '0:true'
  );
  const online = connection.endsWith(':true');
  const available = feeds.filter((feed) =>
    games.some((game) => game.key === feed.key && !!memberGameDestination(game))
  );
  const selected = available.find((feed) => feed.key === selectedGame) ?? available[0];
  const results = useQuery({
    queryKey: ['dashboard-top-returns', userId, selected?.key, connection],
    enabled: online && !!userId && catalogState === 'ready' && !!selected,
    queryFn: async ({ signal }) => {
      if (!selected) throw new Error('No supported results feed');
      return parseDashboardReturns(
        unwrapData(
          await boundedRequest(
            (activeSignal) =>
              api.get<unknown>(selected.endpoint, undefined, { signal: activeSignal }),
            signal
          ),
          'Top returns response'
        )
      );
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnReconnect: 'always',
    retry: false,
  });
  const rows = results.data ? topDashboardReturns(results.data) : [];
  const waiting = catalogState === 'loading' || (!!selected && results.isPending);
  return (
    <div className="ruby-highlights">
      <section className="ruby-return-board" aria-labelledby="lounge-returns-title">
        <div className="ruby-highlight-heading">
          <div>
            <p className="qube-eyebrow">
              <Trophy size={14} aria-hidden="true" /> THE RESULTS BOARD
            </p>
            <h2 id="lounge-returns-title">Top 10 returns</h2>
          </div>
          <span className="ruby-period-chip">
            <Clock3 size={13} aria-hidden="true" /> Last 24 hours
          </span>
        </div>
        <p className="ruby-highlight-caption">
          Confirmed practice ticket returns, refreshed every minute while this page is visible.
        </p>
        {available.length > 0 && catalogState === 'ready' && (
          <div className="ruby-return-toolbar">
            <div role="group" aria-label="Results game" className="ruby-return-tabs">
              {available.map((feed) => (
                <button
                  type="button"
                  key={feed.key}
                  aria-pressed={selected?.key === feed.key}
                  onClick={() => setSelectedGame(feed.key)}
                >
                  {feed.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ruby-return-refresh"
              aria-label="Refresh top returns"
              disabled={!userId || !online || results.isFetching}
              onClick={() => void results.refetch()}
            >
              <RefreshCw size={14} aria-hidden="true" />{' '}
              {results.isFetching ? 'Updating…' : 'Refresh'}
            </button>
          </div>
        )}
        {!userId ? (
          <p className="ruby-highlight-state">Sign in to view the results board.</p>
        ) : catalogState === 'error' ? (
          <p className="ruby-highlight-state" role="status">
            Load the game collection to check available results.
          </p>
        ) : !online ? (
          <p className="ruby-highlight-state" role="status">
            You're offline. Rankings are hidden until a connection is restored.
          </p>
        ) : waiting ? (
          <p className="ruby-highlight-state" role="status">
            {results.fetchStatus === 'paused'
              ? 'Waiting for a connection…'
              : 'Loading confirmed returns…'}
          </p>
        ) : !selected ? (
          <p className="ruby-highlight-state">No supported practice results are available yet.</p>
        ) : results.isError ? (
          <div className="ruby-highlight-state" role="status">
            <p>Results unavailable. Refresh to try again.</p>
            <p>Previous rankings are hidden until the server confirms a new response.</p>
          </div>
        ) : rows.length ? (
          <div
            className="ruby-return-scroll"
            role="region"
            aria-label={`${selected.name} top returns table`}
            tabIndex={0}
          >
            <table>
              <caption className="sr-only">
                {selected.name}: highest confirmed ticket returns in the last 24 hours
              </caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Ticket alias</th>
                  <th scope="col">Return</th>
                  <th scope="col">Cash-out</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ticket, index) => (
                  <tr key={`${ticket.roundId}:${ticket.player}`}>
                    <td>
                      <span className={`ruby-return-rank ${index < 3 ? 'is-podium' : ''}`}>
                        {String(index + 1).padStart(2, '0')}
                      </span>
                    </td>
                    <th scope="row">
                      <span className="ruby-ticket-alias">{ticket.player}</span>
                    </th>
                    <td>
                      <strong>{credits.format(ticket.payout)}</strong>
                      <small>
                        {ticket.payout - ticket.stake >= 0 ? '+' : ''}
                        {credits.format(ticket.payout - ticket.stake)} net ·{' '}
                        {credits.format(ticket.stake)} stake
                      </small>
                    </td>
                    <td>{(ticket.paidCents / 100).toFixed(2)}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ruby-highlight-state">
            No confirmed returns for {selected.name} in the last 24 hours.
          </p>
        )}
        <div className="ruby-return-footer">
          <p>
            Practice credits · no cash value. Returns include stake. Aliases identify tickets, not
            unique players.
          </p>
          {results.dataUpdatedAt > 0 && !results.isError && online && selected && (
            <p>
              Last received:{' '}
              <time dateTime={new Date(results.dataUpdatedAt).toISOString()}>
                {new Date(results.dataUpdatedAt).toLocaleTimeString()}
              </time>{' '}
              (device time)
            </p>
          )}
        </div>
      </section>
      <div className="ruby-highlight-sidebar">
        <section className="ruby-jackpot-card" aria-labelledby="lounge-jackpot-title">
          <div className="ruby-jackpot-icon">
            <Gem size={32} strokeWidth={1.4} aria-hidden="true" />
          </div>
          <p className="qube-eyebrow">ON THE HORIZON</p>
          <h2 id="lounge-jackpot-title">The Jackpot</h2>
          <span className="ruby-jackpot-status">Not launched</span>
          <p>
            A dedicated space for a future jackpot. There is no active prize pool or paid entry.
          </p>
          <div className="ruby-jackpot-rule">
            <ShieldCheck size={18} aria-hidden="true" />
            <span>Funding, eligibility and published rules must be ready before launch.</span>
          </div>
        </section>
        <nav className="ruby-member-shortcuts" aria-label="Your activity">
          <Link to="/games/history">
            <History size={20} aria-hidden="true" />
            <span>
              <strong>Your results</strong>
              <small>Review your personal game history</small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
          <Link to="/rewards">
            <Award size={20} aria-hidden="true" />
            <span>
              <strong>Rewards & progress</strong>
              <small>View tasks and achievements</small>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </nav>
      </div>
    </div>
  );
}
