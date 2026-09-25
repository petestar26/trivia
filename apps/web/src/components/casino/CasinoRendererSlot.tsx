import React from 'react';

const GAME_ICONS: Record<string, string> = {
  dice: '🎲',
  number_challenge: '🔢',
  trivia: '🧠',
  spin_win: '🎡',
  thunder_derby_3d: '⚡',
  neon_hounds_3d: '🐕',
  turbo_circuit_3d: '🏎️',
  starfall_nebula: '⭐',
  jungle_dash_3d: '🌴',
  turbo_keno: '🔢',
  crystal_trail: '💎',
  heat_vault: '🔥',
  strait_rush: '🏁',
};

interface CasinoRendererSlotProps {
  gameKey: string;
  gameName: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Accessible 2D fallback renderer and future renderer slot.
 * Currently renders a styled card with the game icon and name.
 * The `children` slot is reserved for future 3D/WebGL renderers.
 * No Three.js or WebGL is imported here.
 */
export function CasinoRendererSlot({ gameKey, gameName, className, children }: CasinoRendererSlotProps) {
  if (children) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center ${className ?? ''}`}
      role="img"
      aria-label={`${gameName} game area`}
    >
      <div className="text-6xl mb-4">{GAME_ICONS[gameKey] ?? '🎮'}</div>
      <p className="text-lg font-semibold text-gray-900 dark:text-white">{gameName}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
        {gameName === 'Spin Win' || gameName === 'Trivia'
          ? 'Coming soon'
          : 'Game area'}
      </p>
    </div>
  );
}
