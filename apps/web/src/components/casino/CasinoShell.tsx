import React from 'react';
import { Link } from 'react-router-dom';
import { useCasino, type GamePhase } from './CasinoProvider';

interface CasinoShellProps {
  gameKey: string;
  gameName: string;
  rulesVersion?: number | null;
  resultSchemaVersion?: number | null;
  phase?: GamePhase;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  children: React.ReactNode;
}

export function CasinoShell({
  gameKey,
  gameName,
  rulesVersion,
  resultSchemaVersion,
  phase,
  loading = false,
  error = null,
  empty = false,
  children,
}: CasinoShellProps) {
  const {
    coinsBalance,
    soundEnabled,
    setSoundEnabled,
    fullscreenEnabled,
    toggleFullscreen,
    prefersReducedMotion,
  } = useCasino();

  if (loading) {
    return (
      <div className="max-w-md mx-auto space-y-6" role="status" aria-label="Loading">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-40 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto space-y-6" role="alert">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 text-red-700 dark:text-red-400">
          <p className="font-semibold">Error</p>
          <p className="text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="max-w-md mx-auto text-center py-16 text-gray-500 dark:text-gray-400" role="status">
        <p className="text-lg">No data available</p>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6" data-game-key={gameKey}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{gameName}</h1>
          {rulesVersion != null && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Rules v{rulesVersion}{resultSchemaVersion != null ? ` · Schema v${resultSchemaVersion}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/games/history"
            className="text-sm text-primary-600 dark:text-primary-400 hover:underline"
            aria-label="Game history"
          >
            History
          </Link>
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label={soundEnabled ? 'Mute sound' : 'Enable sound'}
            title={soundEnabled ? 'Mute' : 'Sound on'}
          >
            {soundEnabled ? '🔊' : '🔇'}
          </button>
          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label={fullscreenEnabled ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullscreenEnabled ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreenEnabled ? '⊡' : '⛶'}
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
        <span className="text-sm text-gray-600 dark:text-gray-300">Coins</span>
        <span className="text-lg font-bold text-primary-600 dark:text-primary-400">
          {coinsBalance.toLocaleString()}
        </span>
      </div>

      {phase && phase !== 'BETTING_OPEN' && (
        <div className="text-center text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
          {phase === 'LOCKED' && 'Bets locked'}
          {phase === 'RUNNING' && (prefersReducedMotion ? 'Game in progress...' : 'In progress...')}
          {phase === 'RESULT' && 'Result ready'}
          {phase === 'SETTLED' && 'Settled'}
        </div>
      )}

      {children}
    </div>
  );
}
