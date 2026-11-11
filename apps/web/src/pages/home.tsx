import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ArrowRight, Users, Headphones, Wallet, Gift } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import { GuestGameCollection } from '@/components/member/guest-game-collection';
import { GameCollection } from '@/components/member/game-collection';
import { CasinoPreview } from '@/components/member/casino-preview';
import { GameArtwork } from '@/components/member/game-artwork';
import { api, unwrapData } from '@/lib/api';
import './home.css';
import './lounge.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

interface LoungeGroup {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
  isPrivate: boolean;
  status: string;
}
export function HomePage() {
  const { t: translateUi } = useInterfaceLanguage();

  const { user } = useAuth();
  const { t } = useLanguage();
  const groups = useQuery({
    queryKey: ['groups', 'dashboard', user?.id],
    enabled: !!user?.id,
    queryFn: async () => unwrapData<LoungeGroup[]>(await api.listGroups({ limit: 50 })),
    staleTime: 60_000,
  });
  const active = (user ? (groups.data ?? []) : [])
    .filter((g) => g.status === 'ACTIVE' && (!g.isPrivate || g.isMember))
    .slice(0, 4);
  return (
    <div className="salem-lounge">
      <div className="salem-welcome">
        <span className="salem-eyebrow">{'SALEM BET'}</span>
        <p>
          {user ? (
            <>
              {translateUi('Welcome back,') + ' '}
              <strong>{user.displayName || user.username}</strong>
            </>
          ) : (
            translateUi('Look around. Make yourself at home.')
          )}
        </p>
      </div>
      <section className="salem-hero">
        <img src="/art/ruby-grand/lounge.webp" alt="" />
        <div>
          <span className="salem-eyebrow">{translateUi('YOUR GAMES. YOUR PEOPLE.')}</span>
          <h1>
            {translateUi('A little play.')}
            <br />
            <em>{translateUi('A shared moment.')}</em>
          </h1>
          <p>{translateUi('Find a favorite or bring your group together.')}</p>
          <div className="salem-hero-actions">
            <a className="salem-button" href="#our-games">
              {t('Our games')}
              <ArrowUpRight size={17} />
            </a>
            <Link className="salem-button secondary" to="/groups">
              {t('Play together')}
              <Users size={17} />
            </Link>
          </div>
        </div>
      </section>
      <nav className="salem-quick-links" aria-label={translateUi('Quick access')}>
        {[
          [Wallet, 'Wallet', '/wallet'],
          [Gift, 'Gifts', '/gifts'],
          [Headphones, 'Support', '/support'],
        ].map(([Icon, label, to]) => {
          const I = Icon as typeof Wallet;
          return (
            <Link key={String(to)} to={String(to)}>
              <I size={19} />
              {t(String(label))}
              <ArrowUpRight size={15} />
            </Link>
          );
        })}
      </nav>
      <section id="our-games" aria-labelledby="our-games-title">
        <div className="salem-section-heading">
          <div>
            <span className="salem-eyebrow">{translateUi('SALEM ORIGINALS')}</span>
            <h2 id="our-games-title">{t('Our games')}</h2>
          </div>
          <Link to="/games/history">
            {t('History')}
            <ArrowRight size={16} />
          </Link>
        </div>
        {user ? <GameCollection /> : <GuestGameCollection />}
      </section>
      <CasinoPreview />
      <section className="salem-together" aria-labelledby="together-title">
        <div className="salem-section-heading">
          <div>
            <span className="salem-eyebrow">{translateUi('BETTER TOGETHER')}</span>
            <h2 id="together-title">{t('Play together')}</h2>
            <p>{translateUi('One room. One result. Spin, Turbo Keno, or Dice.')}</p>
          </div>
          <Link to="/groups">
            {t('Groups')}
            <ArrowRight size={17} />
          </Link>
        </div>
        <div className="salem-group-preview">
          {[
            ['spin_win', 'Spin'],
            ['turbo_keno', 'Turbo Keno'],
            ['dice', 'Dice'],
          ].map(([key, name]) => (
            <Link to="/groups" key={key} className="salem-group-game">
              <GameArtwork kind={key} practiceAvailable />
              <div>
                <h3>{translateUi(name)}</h3>
                <span>
                  {translateUi('2–20 players') + ' '}
                  <ArrowUpRight size={14} />
                </span>
              </div>
            </Link>
          ))}
        </div>
        <p className="salem-footnote">
          {translateUi(
            'Start with free practice points. Each player confirms their own entry; accepted rounds settle automatically.'
          )}
        </p>
        {groups.isError ? (
          <p role="status">
            {translateUi('Groups could not be loaded.')}{' '}
            <button onClick={() => void groups.refetch()}>{t('Retry')}</button>
          </p>
        ) : (
          active.length > 0 && (
            <div className="salem-group-rooms">
              {active.map((g) => (
                <Link key={g.id} to={`/groups/${g.id}`}>
                  <Users size={18} />
                  <span>
                    <strong>{g.name}</strong>
                    <small>
                      {translateUi('{memberCount} members', { memberCount: g.memberCount })}
                    </small>
                  </span>
                  <ArrowRight size={15} />
                </Link>
              ))}
            </div>
          )
        )}
      </section>
      <footer className="salem-lounge-footer">
        <span>{'SALEM BET'}</span>
        <Link to="/support">
          {t('Help center')}
          <ArrowUpRight size={14} />
        </Link>
      </footer>
    </div>
  );
}
