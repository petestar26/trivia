import { Link } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import {
  Users,
  Wallet,
  MessageCircle,
  ArrowUpRight,
  ArrowRight,
  Clock3,
  Sparkles,
} from 'lucide-react';
import { GameArtwork } from '@/components/member/game-artwork';

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="qube-home">
      <section className="qube-hero">
        <div className="qube-hero-copy">
          <p className="qube-eyebrow">
            <Sparkles size={14} /> THE PLAYQUBE EXPERIENCE
          </p>
          <h1>
            Your table.
            <br />
            <span>Your moment.</span>
          </h1>
          <p className="qube-hero-description">
            Welcome back, {user?.displayName || user?.username}. A new round, a familiar group, a
            little friendly competition. Make yourself at home.
          </p>
          <Link to="/casino" className="qube-primary-link">
            Explore the casino <ArrowUpRight size={19} />
          </Link>
          <p className="qube-hero-note">Free practice tables · no cash prizes</p>
        </div>
        <div className="qube-hero-visual">
          <GameArtwork kind="dice" hero />
          <span className="qube-hero-chip">
            <Clock3 size={15} /> One-minute practice rounds
          </span>
          <span className="qube-hero-word" aria-hidden="true">
            PLAY
          </span>
        </div>
      </section>
      <section aria-labelledby="practice-tables-title">
        <div className="qube-section-heading">
          <div>
            <p className="qube-eyebrow">FIND YOUR FAVORITE</p>
            <h2 id="practice-tables-title">Take a seat</h2>
          </div>
          <Link to="/casino">
            All games <ArrowRight size={16} />
          </Link>
        </div>
        <div className="qube-featured-grid">
          {[
            {
              kind: 'spin_win',
              name: 'Spin',
              to: '/games/spin-win',
              text: 'A fresh turn of the wheel.',
            },
            {
              kind: 'turbo_keno',
              name: 'Keno',
              to: '/games/turbo-keno',
              text: 'Pick your numbers. Follow the draw.',
            },
            {
              kind: 'dice',
              name: 'Dice',
              to: '/games/dice',
              text: 'Simple picks. A new roll every minute.',
            },
          ].map((game) => (
            <Link
              to={game.to}
              key={game.kind}
              className={`qube-game-tile qube-game-tile--${game.kind}`}
            >
              <GameArtwork kind={game.kind} />
              <div className="qube-game-tile-copy">
                <span className="qube-tag">Free practice</span>
                <div className="flex items-center justify-between gap-3">
                  <h3>{game.name}</h3>
                  <span className="qube-tile-arrow">
                    <ArrowUpRight size={20} />
                  </span>
                </div>
                <p>{game.text}</p>
              </div>
            </Link>
          ))}
        </div>
        <p className="qube-disclosure">
          Practice credits have no cash value. Group games use Game Points.
        </p>
      </section>
      <section aria-label="Quick access" className="qube-quick-grid">
        {[
          {
            to: '/groups',
            title: 'Better together',
            text: 'Find your group and choose a game.',
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
            text: 'Balances, requests and transaction history.',
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
