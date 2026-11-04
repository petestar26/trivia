import { GamesPage } from '@/pages/games';

/** The casino catalog contains COINS-wager games only; BONUS games stay in Games. */
export function CasinoPage() {
  return (
    <GamesPage
      mode="WAGER"
      title="Casino"
      description="Explore system games and check each table’s availability. Find player-versus-player games inside your groups."
      emptyMessage="No casino games are available right now."
    />
  );
}
