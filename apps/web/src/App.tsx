import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { Layout } from '@/components/layout/layout';
import { HomePage } from '@/pages/home';
import { LoginPage } from '@/pages/login';
import { RegisterPage } from '@/pages/register';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { GamesPage } from '@/pages/games';
import { DiceGamePage } from '@/pages/games/dice';
import { LuckySpinPage } from '@/pages/games/lucky-spin';
import { NumberChallengePage } from '@/pages/games/number-challenge';
import { TriviaGamePage } from '@/pages/games/trivia';
import { GameHistoryPage } from '@/pages/games/history';
import { ChallengesPage } from '@/pages/challenges';
import { ChallengeDetailPage } from '@/pages/challenges/detail';
import { CompetitionsPage } from '@/pages/competitions';
import { GroupCompetitionsPage } from '@/pages/competitions/index';
import { CompetitionDetailPage } from '@/pages/competitions/detail';

export function App() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <Routes>
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
        <Route path="games" element={<GamesPage />} />
        <Route path="games/history" element={<GameHistoryPage />} />
        <Route path="games/dice" element={<DiceGamePage />} />
        <Route path="games/lucky-spin" element={<LuckySpinPage />} />
        <Route path="games/number-challenge" element={<NumberChallengePage />} />
        <Route path="games/trivia" element={<TriviaGamePage />} />
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