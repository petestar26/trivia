import { GamesPage } from '@/pages/games';

/** The casino catalog contains COINS-wager games only; BONUS games stay in Games. */
export function CasinoPage() {
  return (
    <GamesPage
      mode="WAGER"
      title="Casino"
      description="Explore casino games played with Coins."
      emptyMessage="No casino games are available right now."
    />
  );
}
