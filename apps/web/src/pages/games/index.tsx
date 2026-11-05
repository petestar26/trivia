import { Link, useLocation } from 'react-router-dom';
import { Users, History, ArrowUpRight } from 'lucide-react';
import { GameCollection } from '@/components/member/game-collection';
import { useLanguage } from '@/providers/language-provider';
import '../lounge.css';
interface GamesPageProps {
  mode?: 'WAGER' | 'BONUS';
  title?: string;
  description?: string;
  emptyMessage?: string;
}
export function GamesPage({ mode, title, description }: GamesPageProps = {}) {
  const { t } = useLanguage();
  const location = useLocation();
  const queryMode = new URLSearchParams(location.search).get('mode');
  const selected = mode ?? (queryMode === 'WAGER' || queryMode === 'BONUS' ? queryMode : undefined);
  return (
    <div className="salem-lounge">
      <header className="salem-page-heading">
        <div>
          <span className="salem-eyebrow">SALEM ORIGINALS</span>
          <h1>{title || t('Our games')}</h1>
          <p>{description || 'Pick a game and start playing.'}</p>
        </div>
        <Link to="/games/history" className="salem-button secondary">
          <History size={16} />
          {t('History')}
        </Link>
      </header>
      <nav className="salem-discovery-links" aria-label="Play modes">
        <Link to="/games" aria-current={!selected ? 'page' : undefined}>
          {t('Our games')}
        </Link>
        <Link to="/casino">
          {t('Casino')}
          <ArrowUpRight size={14} />
        </Link>
        <Link to="/groups">
          <Users size={15} />
          {t('Play together')}
        </Link>
      </nav>
      <GameCollection mode={selected} />
    </div>
  );
}
