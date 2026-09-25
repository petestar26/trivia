import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface WalletData {
  coinsBalance: number;
  gamePointsBalance: number;
}

export type GamePhase = 'BETTING_OPEN' | 'LOCKED' | 'RUNNING' | 'RESULT' | 'SETTLED';

interface CasinoContextValue {
  coinsBalance: number;
  refetchBalance: () => void;
  soundEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;
  fullscreenEnabled: boolean;
  toggleFullscreen: () => void;
  prefersReducedMotion: boolean;
  phase: GamePhase;
  setPhase: (p: GamePhase) => void;
}

const CasinoContext = createContext<CasinoContextValue | null>(null);

export function CasinoProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const { data: wallet, refetch: refetchBalance } = useQuery<WalletData>({
    queryKey: ['wallet', user?.id],
    queryFn: async () => unwrapData<WalletData>(await api.get<WalletData>('/wallet'), 'Wallet'),
    enabled: !!user?.id,
  });

  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('casino-sound') !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('casino-sound', soundEnabled ? 'on' : 'off'); } catch { /* noop */ }
  }, [soundEnabled]);

  const [fullscreenEnabled, setFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => {});
    }
  }, []);
  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const [prefersReducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const [phase, setPhase] = useState<GamePhase>('BETTING_OPEN');

  return (
    <CasinoContext.Provider value={{
      coinsBalance: wallet?.coinsBalance ?? 0,
      refetchBalance,
      soundEnabled,
      setSoundEnabled,
      fullscreenEnabled,
      toggleFullscreen,
      prefersReducedMotion,
      phase,
      setPhase,
    }}>
      {children}
    </CasinoContext.Provider>
  );
}

export function useCasino() {
  const ctx = useContext(CasinoContext);
  if (!ctx) throw new Error('useCasino must be used within CasinoProvider');
  return ctx;
}
