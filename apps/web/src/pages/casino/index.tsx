import { GamesPage } from '@/pages/games';

/** The casino catalog contains COINS-wager games only; BONUS games stay in Games. */
export function CasinoPage() {
  return (
    <GamesPage
      mode="WAGER"
      title="Casino"
      description="System tables run every minute. Try Spin, Keno and Dice with free practice credits. Find player-versus-player games inside your groups."
      emptyMessage="No casino games are available right now."
    />
  );
}
