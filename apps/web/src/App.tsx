import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { Layout } from '@/components/layout/layout';
import { HomePage } from '@/pages/home';
import { LoginPage } from '@/pages/login';
import { RegisterPage } from '@/pages/register';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { CasinoProvider } from '@/components/casino/CasinoProvider';
import { GamesPage } from '@/pages/games';
import { CasinoPage } from '@/pages/casino';
import { SystemDicePage } from '@/pages/games/dice-system';
import { LuckySpinPage } from '@/pages/games/lucky-spin';
import { SpinWinScheduledPage } from '@/pages/games/spin-win-scheduled';
import { SystemKenoPage } from '@/pages/games/keno-system';
import { SpinWinCoinsPage } from '@/pages/games/spin-win-coins';
import { NumberChallengePage } from '@/pages/games/number-challenge';
import { TriviaGamePage } from '@/pages/games/trivia';
import { GameHistoryPage } from '@/pages/games/history';
import { ChallengesPage } from '@/pages/challenges';
import { ChallengeDetailPage } from '@/pages/challenges/detail';
import { CompetitionsPage } from '@/pages/competitions';
import { GroupCompetitionsPage } from '@/pages/competitions/index';
import { CompetitionDetailPage } from '@/pages/competitions/detail';
import { GroupsPage } from '@/pages/groups';
import { GroupDetailPage } from '@/pages/group-detail';
import { GroupInviteAcceptPage } from '@/pages/group-invite-accept';
import { MessagesPage } from '@/pages/messages';
import { GroupGamesPage } from '@/pages/group-games';
import { GroupGiftsPage } from '@/pages/group-gifts';
import { WalletPage } from '@/pages/wallet';
import { RewardsPage } from '@/pages/rewards';
import { ProfilePage } from '@/pages/profile';

// Keep pairing-verification code out of the normal casino entry bundle.
const SpinWinVerifyPage = lazy(async () => {
  const page = await import('@/pages/games/spin-win-verify');
  return { default: page.SpinWinVerifyPage };
});

export function App() {
  const { isLoading } = useAuth();
  const location = useLocation();

  // Offline public verification must also work while the unrelated session
  // probe is waiting on an unavailable API.
  if (isLoading && !/^\/games\/spin-win\/verify\/?$/.test(location.pathname)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/games/spin-win/verify" element={
        <Suspense fallback={<main className="min-h-screen bg-slate-950 p-8 text-slate-100">Loading round verifier…</main>}>
          <SpinWinVerifyPage />
        </Suspense>
      } />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="groups/invite/:token" element={<GroupInviteAcceptPage />} />
        <Route path="groups/:id" element={<GroupDetailPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="messages/:groupId" element={<MessagesPage />} />
        <Route path="groups/:id/games" element={<GroupGamesPage />} />
        <Route path="groups/:id/gifts" element={<GroupGiftsPage />} />
        <Route path="gifts" element={<GroupGiftsPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="rewards" element={<RewardsPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="casino" element={<CasinoPage />} />
        <Route path="games/history" element={<GameHistoryPage />} />
        <Route
          path="games/dice"
          element={
            <CasinoProvider>
              <SystemDicePage />
            </CasinoProvider>
          }
        />
        <Route path="games/lucky-spin" element={<LuckySpinPage />} />
        <Route path="games/spin-win/live" element={<SpinWinScheduledPage />} />
        <Route path="games/spin-win" element={<SpinWinScheduledPage />} />
        <Route path="games/turbo-keno" element={<CasinoProvider><SystemKenoPage /></CasinoProvider>} />
        <Route path="games/spin-win/play" element={<CasinoProvider><SpinWinCoinsPage /></CasinoProvider>} />
        <Route
          path="games/number-challenge"
          element={
            <CasinoProvider>
              <NumberChallengePage />
            </CasinoProvider>
          }
        />
        <Route
          path="games/trivia"
          element={
            <CasinoProvider>
              <TriviaGamePage />
            </CasinoProvider>
          }
        />
        <Route path="challenges" element={<ChallengesPage />} />
        <Route path="challenges/:id" element={<ChallengeDetailPage />} />
        <Route path="competitions" element={<CompetitionsPage />} />
        <Route path="competitions/:groupId" element={<GroupCompetitionsPage />} />
        <Route path="competitions/:groupId/:competitionId" element={<CompetitionDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
