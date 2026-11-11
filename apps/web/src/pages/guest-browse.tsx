import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Dice5,
  LockKeyhole,
  ShieldCheck,
  Trophy,
  Users,
} from 'lucide-react';
import { HomePage } from './home';
import { GameArtwork } from '@/components/member/game-artwork';
import { GUEST_GAMES, GuestGameCollection } from '@/components/member/guest-game-collection';
import { PRACTICE_ROUTES } from '@/lib/member-game-catalog';
import { invitePath } from '@/lib/guest-browse-location';
import { useGuestAuth } from '@/components/auth/guest-auth-prompt';
import { useLanguage } from '@/providers/language-provider';
import './sports.css';

function GuestAction({ children, reason }: { children: React.ReactNode; reason: string }) {
  const { requestSignIn } = useGuestAuth();
  const { t } = useLanguage();
  return (
    <button className="salem-button" onClick={() => requestSignIn(t(reason))}>
      {children}
      <ArrowUpRight size={17} />
    </button>
  );
}

const features: Record<
  string,
  {
    title: string;
    kicker: string;
    copy: string;
    artwork: string;
    action: string;
    points: string[];
  }
> = {
  groups: {
    title: 'Good company. Great moments.',
    kicker: 'GROUPS',
    copy: 'A place for your people, your conversations, and your next shared game.',
    artwork: 'groups',
    action: 'Find a group',
    points: [
      'Discover groups after signing in',
      'Keep private rooms private',
      'Choose when to join a game',
    ],
  },
  messages: {
    title: 'Keep the conversation going.',
    kicker: 'MESSAGES',
    copy: 'Chat with your groups and pick up where you left off. Your conversations stay in your account.',
    artwork: 'messages',
    action: 'Open messages',
    points: [
      'Group conversations',
      'Voice messages and shared moments',
      'Your message history, kept private',
    ],
  },
  wallet: {
    title: 'Your wallet. In your control.',
    kicker: 'WALLET',
    copy: 'See your available balance and review your transactions in one place. Your account details are only shown after sign-in.',
    artwork: 'wallet',
    action: 'Open wallet',
    points: [
      'Review your balance and history',
      'Keep cash and practice funds separate',
      'Review each transaction before you confirm',
    ],
  },
  gifts: {
    title: 'Make a small moment special.',
    kicker: 'GIFTS',
    copy: 'Explore collectible gifts and share a little appreciation with your group.',
    artwork: 'gift',
    action: 'Explore gifts',
    points: [
      'Discover the gift collection',
      'Choose a recipient yourself',
      'Review the details before sending',
    ],
  },
  rewards: {
    title: 'A space for your rewards.',
    kicker: 'REWARDS',
    copy: 'See the rewards available to your account and follow your progress, all in one place.',
    artwork: 'award',
    action: 'View my rewards',
    points: [
      'Account-specific reward details',
      'Clear eligibility and availability',
      'Your progress stays private',
    ],
  },
  support: {
    title: 'A little help, when you need it.',
    kicker: 'SUPPORT',
    copy: 'Connect with support from your account, so your question and its updates stay together.',
    artwork: 'messages',
    action: 'Contact support',
    points: [
      'Get help with your account',
      'Keep track of your requests',
      'Never share your password in a message',
    ],
  },
  profile: {
    title: 'Make it your own.',
    kicker: 'PROFILE',
    copy: 'Manage your profile and account settings in your own private space.',
    artwork: 'groups',
    action: 'Open my profile',
    points: [
      'Your display name and profile',
      'Account and security settings',
      'Your personal information stays private',
    ],
  },
  challenges: {
    title: 'Bring a little friendly competition.',
    kicker: 'CHALLENGES',
    copy: 'Explore challenges with your group. Check the rules and choose whether to take part.',
    artwork: 'award',
    action: 'Explore challenges',
    points: [
      'See the rules before joining',
      'Choose your own participation',
      'Follow your account activity',
    ],
  },
  competitions: {
    title: 'Something to share. A reason to play.',
    kicker: 'COMPETITIONS',
    copy: 'Discover competitions in your groups and review the details before entering.',
    artwork: 'award',
    action: 'Explore competitions',
    points: [
      'Group competitions',
      'Clear entry requirements',
      'Your own confirmation before participation',
    ],
  },
};

/** This boundary is intentionally data-free: member pages and protected APIs never mount. */
export function GuestBrowsePage() {
  const { pathname, search } = useLocation();
  const { t } = useLanguage();
  const section = pathname.split('/')[1];
  if (['/', '/dashboard', '/explore'].includes(pathname)) return <HomePage />;
  // The invitation itself is fetched only after sign-in; the link is kept for that.
  if (invitePath(pathname))
    return (
      <FeatureOverview
        feature={{
          ...features.groups,
          title: 'Group invitation',
          copy: 'Sign in or create an account to use this feature.',
          action: 'Accept invite',
        }}
      />
    );
  if (section === 'casino' || pathname === '/games/provider-demos') return <GuestCasino />;
  if (section === 'sports') return <GuestSports />;
  if (section === 'play-together' || section === 'games') {
    if (pathname === '/games/history')
      return (
        <FeatureOverview
          feature={{
            title: 'Your games, all in one place.',
            kicker: 'HISTORY',
            copy: 'Your personal game records are available after signing in.',
            artwork: 'groups',
            action: 'View my history',
            points: ['Your past rounds', 'Results linked to your account', 'Private by default'],
          }}
        />
      );
    const selected =
      new URLSearchParams(search).get('game') ||
      Object.entries(PRACTICE_ROUTES).find(([, route]) => route === pathname)?.[0];
    const game = GUEST_GAMES.find(([key]) => key === selected);
    return (
      <div className="salem-lounge salem-guest-browse">
        <header className="salem-guest-heading">
          <span className="salem-eyebrow">{t('PLAY TOGETHER')}</span>
          <h1>{t('Your games. Your people.')}</h1>
          <p>{t('Explore the collection, then choose a room when you are ready to join.')}</p>
        </header>
        {game && (
          <section className="salem-guest-selected" aria-labelledby="selected-game-title">
            <GameArtwork kind={game[0]} practiceAvailable />
            <div>
              <span className="salem-eyebrow">{t('SALEM ORIGINALS')}</span>
              <h2 id="selected-game-title">{t(game[1])}</h2>
              <p>{t(game[2])}</p>
              <p className="salem-footnote">
                {t(
                  'Availability and entry rules are checked after sign-in. Nothing is entered automatically.'
                )}
              </p>
              <GuestAction reason="Sign in to choose a room and review its rules before joining.">
                {t('Find a room')}
              </GuestAction>
            </div>
          </section>
        )}
        <div className="salem-guest-steps">
          {['Explore a game', 'Choose your group', 'Review, then join'].map((step, index) => (
            <div key={step}>
              <span>0{index + 1}</span>
              <strong>{t(step)}</strong>
            </div>
          ))}
        </div>
        <GuestGameCollection />
        <section className="salem-guest-note">
          <Users size={23} />
          <div>
            <h2>{t('Better with your group')}</h2>
            <p>
              {t(
                'Every player chooses their own participation. Browsing never joins a room or starts a round.'
              )}
            </p>
          </div>
          <GuestAction reason="Sign in to find or create a group.">{t('Find a group')}</GuestAction>
        </section>
      </div>
    );
  }
  const feature = features[section];
  if (feature) return <FeatureOverview feature={feature} />;
  return (
    <div className="salem-lounge salem-guest-browse">
      <h1>{t('Page not found')}</h1>
      <p>{t('Choose a section from the menu or return home.')}</p>
      <Link className="salem-button" to="/dashboard">
        {t('Home')}
        <ArrowRight size={17} />
      </Link>
    </div>
  );
}

/** Decorative, local-only artwork. It never represents account state or a live game. */
function GuestPicture({ name }: { name: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      className="salem-guest-picture"
      data-loaded={loaded}
      onLoad={() => setLoaded(true)}
      src={`/artwork/guest-3d/${name}.webp`}
      alt=""
      width={640}
      height={640}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

function FeatureOverview({ feature }: { feature: (typeof features)[string] }) {
  const { t } = useLanguage();
  return (
    <section className="salem-lounge salem-guest-browse">
      <div className="salem-guest-feature">
        <div className="salem-guest-feature-copy">
          <span className="salem-eyebrow">{t(feature.kicker)}</span>
          <h1>{t(feature.title)}</h1>
          <p>{t(feature.copy)}</p>
          <GuestAction reason="Sign in to use this feature. Your account details stay private.">
            {t(feature.action)}
          </GuestAction>
        </div>
        <div
          key={feature.kicker}
          className="salem-guest-feature-art salem-guest-motion-art"
          aria-hidden="true"
        >
          <GuestPicture name={feature.artwork} />
        </div>
      </div>
      <div className="salem-guest-benefits">
        {feature.points.map((point) => (
          <div key={point}>
            <Check size={18} />
            <p>{t(point)}</p>
          </div>
        ))}
      </div>
      <div className="salem-guest-note">
        <LockKeyhole size={22} />
        <div>
          <h2>{t('Private until you sign in')}</h2>
          <p>
            {t('No account details, messages, balances, or private groups are shown to visitors.')}
          </p>
        </div>
      </div>
      <div className="salem-section-heading">
        <h2>{t('Keep exploring')}</h2>
        <Link to="/dashboard">
          {t('Home')}
          <ArrowRight size={17} />
        </Link>
      </div>
      <nav className="salem-quick-links" aria-label={t('Explore more')}>
        <Link to="/play-together">
          <Users size={19} />
          {t('Play together')}
          <ArrowUpRight size={15} />
        </Link>
        <Link to="/casino">
          <Dice5 size={19} />
          {t('Casino')}
          <ArrowUpRight size={15} />
        </Link>
        <Link to="/sports">
          <Trophy size={19} />
          {t('Sports')}
          <ArrowUpRight size={15} />
        </Link>
      </nav>
    </section>
  );
}

function GuestCasino() {
  const { t } = useLanguage();
  const categories = [
    ['Slots', 'slots', 'Reels, themes, and new discoveries.'],
    ['Live casino', 'live', 'Explore the live casino collection.'],
    ['Table games', 'table', 'Discover familiar table-game classics.'],
    ['Crash', 'crash', 'Explore the crash game collection.'],
  ] as const;
  return (
    <section className="salem-lounge salem-guest-browse">
      <header className="salem-guest-heading">
        <span className="salem-eyebrow">{t('THE CASINO COLLECTION')}</span>
        <h1>{t('Find your kind of play.')}</h1>
        <p>
          {t(
            'Explore casino categories. Sign in to see the current provider catalogue and account availability.'
          )}
        </p>
      </header>
      <div className="salem-guest-category-grid">
        {categories.map(([name, artwork, copy]) => (
          <article className="salem-guest-category" key={name}>
            <div className="salem-guest-motion-art" aria-hidden="true">
              <GuestPicture name={artwork} />
            </div>
            <span className="salem-eyebrow">{t('CASINO')}</span>
            <h2>{t(name)}</h2>
            <p>{t(copy)}</p>
            <GuestAction reason="Sign in to view the current casino collection. Games do not launch automatically.">
              {t('View collection')}
            </GuestAction>
          </article>
        ))}
      </div>
      <section className="salem-guest-note">
        <ShieldCheck size={24} />
        <div>
          <h2>{t('Availability, without the guesswork')}</h2>
          <p>
            {t(
              'The live provider catalogue is available after sign-in. These categories are an introduction, not a live list of available games.'
            )}
          </p>
        </div>
      </section>
      <div className="salem-section-heading">
        <h2>{t('Our games')}</h2>
        <Link to="/play-together">
          {t('View all')}
          <ArrowRight size={17} />
        </Link>
      </div>
      <GuestGameCollection />
    </section>
  );
}

function GuestSports() {
  const { t } = useLanguage();
  return (
    <section className="salem-sports salem-guest-browse">
      <header className="sports-heading">
        <div>
          <p className="sports-eyebrow">{t('SALEM BET SPORTS')}</p>
          <h1>
            {t('Every match.')}
            <br />
            <em>{t('Your moment.')}</em>
          </h1>
          <p>{t('Discover the sports experience, with your account kept private.')}</p>
        </div>
        <span className="salem-guest-status">
          <ShieldCheck size={17} />
          {t('Browsing as a guest')}
        </span>
      </header>
      <section className="sports-feature">
        <div className="sports-feature-copy">
          <span className="sports-provider">
            <Trophy size={17} />
            {t('NOCTURN SPORT')}
          </span>
          <h2>
            {t('The game starts')}
            <br />
            {t('with the fixtures.')}
          </h2>
          <p>
            {t(
              'Sign in to open the sportsbook. You will return here first and choose when to open it.'
            )}
          </p>
          <GuestAction reason="Sign in to open sports. No sportsbook session or bet is created automatically.">
            {t('Sign in to open sports')}
          </GuestAction>
        </div>
        <div className="salem-guest-stadium">
          <img src="/art/ruby-grand/football-stadium.webp" alt="" />
          <span>{t('Illustration · Not a live match')}</span>
        </div>
      </section>
      <section className="salem-guest-note">
        <LockKeyhole size={22} />
        <div>
          <h2>{t('Real information, when it is available')}</h2>
          <p>
            {t(
              'Public fixtures and odds are not currently provided. Sign in to check the sportsbook; balances and activity remain private.'
            )}
          </p>
        </div>
      </section>
    </section>
  );
}
