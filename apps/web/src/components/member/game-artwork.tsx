import {
  Brain,
  Gem,
  Flame,
  Flag,
  Zap,
  Orbit,
  Compass,
  Mountain,
  Trophy,
  Dog,
  Hash,
} from 'lucide-react';

const images: Record<string, string> = { spin_win: 'spin', turbo_keno: 'keno', dice: 'dice' };
const symbols: Record<string, typeof Brain> = {
  trivia: Brain,
  number_challenge: Hash,
  thunder_derby_3d: Trophy,
  neon_hounds_3d: Dog,
  turbo_circuit_3d: Flag,
  starfall_nebula: Orbit,
  jungle_dash_3d: Mountain,
  crystal_trail: Gem,
  heat_vault: Flame,
  strait_rush: Compass,
};
/** Decorative artwork only, never a live result or a promise that an upcoming game is ready. */
export function GameArtwork({ kind, hero = false }: { kind: string; hero?: boolean }) {
  const asset = images[kind];
  const Symbol = symbols[kind] || Zap;
  return asset ? (
    <div
      className={`ruby-art ruby-art--${kind} ${hero ? 'ruby-art--hero' : ''}`}
      aria-hidden="true"
    >
      <img src={`/art/ruby-grand/${asset}.webp`} alt="" loading="lazy" decoding="async" />
    </div>
  ) : (
    <div className={`ruby-art ruby-art--sculpture ruby-art--${kind}`} aria-hidden="true">
      <div className="ruby-sculpture-orbit" />
      <div className="ruby-sculpture">
        <Symbol size={72} strokeWidth={1.05} />
      </div>
      <div className="ruby-sculpture-plinth" />
    </div>
  );
}
