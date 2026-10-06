import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/providers/auth-provider';
import {
  Users,
  Wallet,
  MessageCircle,
  ArrowUpRight,
  ArrowRight,
  Sparkles,
  LockKeyhole,
  Plus,
} from 'lucide-react';
import { GameArtwork } from '@/components/member/game-artwork';
import { MotionShelf } from '@/components/member/motion-shelf';
import { api, unwrapData } from '@/lib/api';
import {
  memberGameDestination,
  memberGameLabel,
  PRACTICE_ROUTES,
  type MemberGame,
} from '@/lib/member-game-catalog';

interface LoungeGroup {
  id: string;
  name: string;
  description?: string | null;
  memberCount: number;
  isMember: boolean;
  isPrivate: boolean;
  status: string;
}

export function HomePage() {
  const { user } = useAuth();
  const catalog = useQuery({
    queryKey: ['games'],
    queryFn: async () =>
      unwrapData<MemberGame[]>(await api.get<MemberGame[]>('/games'), 'Games response'),
    staleTime: 60_000,
  });
  const groups = useQuery({
    queryKey: ['groups', 'dashboard'],
    queryFn: async () =>
      unwrapData<LoungeGroup[]>(await api.listGroups({ limit: 50 }), 'Groups response'),
    enabled: !!user?.id,
    refetchInterval: 60_000,
  });
  const wallet = useQuery({
    queryKey: ['wallet', user?.id],
    queryFn: async () =>
      unwrapData<{ coinsBalance: number; gamePointsBalance: number }>(
        await api.get('/wallet'),
        'Wallet response'
      ),
    enabled: !!user?.id,
  });
  const games = (catalog.data ?? [])
    .filter((g) => g.catalogStatus !== 'RETIRED')
    .sort(
      (a, b) =>
        Number(!!memberGameDestination(b)) - Number(!!memberGameDestination(a)) ||
        a.name.localeCompare(b.name)
    );
  // Private rooms appear only for their own members. "Active" describes open rooms, not online presence.
  const activeGroups = (groups.data ?? []).filter(
    (g) => g.status === 'ACTIVE' && (!g.isPrivate || g.isMember)
  );
  return (
    <div className="qube-home ruby-home">
      <section className="ruby-hero">
        <img src="/art/ruby-grand/lounge.webp" alt="" className="ruby-hero-art" />
        <div className="ruby-hero-copy">
          <p className="qube-eyebrow">
            <Sparkles size={14} /> PLAY TOGETHER. DISCOVER MORE.
          </p>
          <h1>
            Find your
            <br />
            <span>next game.</span>
          </h1>
          <p>
            Welcome back, {user?.displayName || user?.username}. Your favorite games and your
            people, all in one place.
          </p>
          <Link to="/casino" className="qube-primary-link">
            Explore games <ArrowUpRight size={18} />
          </Link>
          <p className="ruby-hero-note">Free practice · no cash prizes</p>
        </div>
        <span className="ruby-hero-seal">
          RUBY GRAND <span>THE MEMBER LOUNGE</span>
        </span>
      </section>
      <div className="ruby-welcome-strip">
        <div>
          <span className="ruby-status-dot" /> A new round every minute{' '}
          <small>Spin · Keno · Dice · Crash Point practice</small>
        </div>
        <Link to="/wallet">
          <Wallet size={18} />
          <span>
            Coins <b>{wallet.data?.coinsBalance ?? '—'}</b>
          </span>
          <span>
            Game Points <b>{wallet.data?.gamePointsBalance ?? '—'}</b>
          </span>
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <section aria-labelledby="lounge-games-title">
        <div className="qube-section-heading">
          <div>
            <p className="qube-eyebrow">THE GAME COLLECTION</p>
            <h2 id="lounge-games-title">Every game. Your way.</h2>
          </div>
          <Link to="/casino">
            Casino <ArrowRight size={16} />
          </Link>
        </div>
        {catalog.isPending ? (
          <div className="ruby-loading" role="status">
            Loading the game collection…
          </div>
        ) : catalog.isError ? (
          <div className="ruby-empty" role="alert">
            <p>We couldn't load the games.</p>
            <button onClick={() => void catalog.refetch()}>Retry games</button>
          </div>
        ) : games.length ? (
          <MotionShelf label="Games" count={games.length + 1} allowGrid>
            {games.map((game) => {
              const to = memberGameDestination(game);
              const content = (
                <>
                  <GameArtwork kind={game.key} />
                  <div className="ruby-game-copy">
                    <span className={`ruby-game-status ${to ? 'is-ready' : ''}`}>
                      {memberGameLabel(game)}
                    </span>
                    <h3>{game.name}</h3>
                    <p>
                      {PRACTICE_ROUTES[game.key]
                        ? 'One-minute rounds · practice credits only.'
                        : to
                          ? game.mode === 'BONUS'
                            ? 'Test your knowledge. Play for free.'
                            : 'Explore the game and its published rules.'
                          : 'A new experience is on its way.'}
                    </p>
                    <span className="ruby-game-action">
                      {to ? (
                        <>
                          Explore game <ArrowUpRight size={17} />
                        </>
                      ) : (
                        <>
                          <LockKeyhole size={13} /> Not yet available
                        </>
                      )}
                    </span>
                  </div>
                </>
              );
              return to ? (
                <Link className="ruby-game-card" key={game.id} to={to}>
                  {content}
                </Link>
              ) : (
                <article className="ruby-game-card is-upcoming" key={game.id}>
                  {content}
                </article>
              );
            })}
            <article className="ruby-future-card">
              <div className="ruby-future-gem">
                <Plus size={36} />
              </div>
              <span>THE COLLECTION GROWS</span>
              <h3>More to discover</h3>
              <p>
                A place for the next game.
                <br />
                New releases appear here when ready.
              </p>
            </article>
          </MotionShelf>
        ) : (
          <div className="ruby-empty">The game collection is being prepared.</div>
        )}
        <p className="qube-disclosure">
          Practice credits have no cash value. Group games use Game Points. Upcoming games cannot be
          played yet.
        </p>
      </section>
      <section aria-labelledby="lounge-groups-title">
        <div className="qube-section-heading">
          <div>
            <p className="qube-eyebrow">BETTER TOGETHER</p>
            <h2 id="lounge-groups-title">Active groups</h2>
          </div>
          <Link to="/groups">
            Browse groups <ArrowRight size={16} />
          </Link>
        </div>
        {groups.isPending ? (
          <div className="ruby-loading" role="status">
            Loading active groups…
          </div>
        ) : groups.isError ? (
          <div className="ruby-empty" role="alert">
            <p>We couldn't load the groups.</p>
            <button onClick={() => void groups.refetch()}>Retry groups</button>
          </div>
        ) : activeGroups.length ? (
          <MotionShelf label="Groups" count={activeGroups.length}>
            {activeGroups.map((group, index) => (
              <Link to={`/groups/${group.id}`} className="ruby-group-card" key={group.id}>
                <div className={`ruby-group-scene ruby-group-scene--${index % 3}`}>
                  <Users size={46} strokeWidth={1.25} />
                  <span>{group.isPrivate ? 'PRIVATE · YOUR GROUP' : 'PUBLIC ROOM'}</span>
                </div>
                <div className="ruby-group-copy">
                  <span className="ruby-group-members">
                    <span className="ruby-status-dot" />
                    {group.memberCount} member{group.memberCount === 1 ? '' : 's'}
                  </span>
                  <h3>{group.name}</h3>
                  <p>{group.description || 'Talk, connect and choose your next game together.'}</p>
                  <span className="ruby-game-action">
                    {group.isMember ? 'Open your group' : 'View group'} <ArrowUpRight size={17} />
                  </span>
                </div>
              </Link>
            ))}
          </MotionShelf>
        ) : (
          <div className="ruby-empty ruby-group-empty">
            <Users size={32} />
            <div>
              <h3>Your next group starts here.</h3>
              <p>No active groups to show yet. Find your people or create a new room.</p>
            </div>
            <Link to="/groups" className="qube-primary-link">
              Explore groups <ArrowUpRight size={16} />
            </Link>
          </div>
        )}
      </section>
      <section aria-label="Quick access" className="qube-quick-grid">
        {[
          {
            to: '/groups',
            title: 'Your community',
            text: 'Choose a game. Share the moment.',
            Icon: Users,
          },
          {
            to: '/messages',
            title: 'Keep in touch',
            text: 'Conversations, reactions and gifts.',
            Icon: MessageCircle,
          },
          {
            to: '/wallet',
            title: 'Your wallet',
            text: 'Balances and transaction history.',
            Icon: Wallet,
          },
        ].map(({ to, title, text, Icon }) => (
          <Link to={to} key={to} className="qube-quick-card">
            <span className="qube-quick-icon">
              <Icon size={23} />
            </span>
            <div>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
            <ArrowUpRight size={18} className="qube-quick-arrow" />
          </Link>
        ))}
      </section>
    </div>
  );
}
