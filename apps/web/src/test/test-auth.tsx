import { createContext, useContext, type ReactNode } from 'react';

/**
 * A controllable stand-in for the authenticated identity, for tests that need
 * to move between accounts on ONE QueryClient WITHOUT the real AuthProvider —
 * which clears the whole query cache at every identity change and would hide
 * exactly the defects those tests exist to catch.
 *
 * Tests mock `@/providers/auth-provider` so `useAuth` is `useTestAuth`, then
 * wrap the tree in <TestAuthProvider user={...}>. Passing `user={null}` is an
 * unresolved / signed-out identity.
 */
export interface TestUser {
  id: string;
  username: string;
}

const TestAuthContext = createContext<{ user: TestUser | null } | null>(null);

export function TestAuthProvider({ user, children }: { user: TestUser | null; children: ReactNode }) {
  return <TestAuthContext.Provider value={{ user }}>{children}</TestAuthContext.Provider>;
}

export function useTestAuth() {
  const ctx = useContext(TestAuthContext);
  if (!ctx) throw new Error('useTestAuth used outside <TestAuthProvider>');
  return { user: ctx.user, isAuthenticated: ctx.user !== null, isLoading: false };
}
