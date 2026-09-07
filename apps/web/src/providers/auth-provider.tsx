import { createContext, useContext, useEffect, useState, useRef, ReactNode, Fragment } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { UserPublicProfile } from '@socialplay/shared';

interface AuthContextType {
  user: UserPublicProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; password: string; displayName?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Authority model — credential operations outrank passive probes.
 *
 * Three monotonic/counted refs:
 *
 * 1. credGenRef (credential generation)
 *    Advanced at the START of every credential-changing operation (login,
 *    register, logout). A credential response publishes ONLY if its claim is
 *    still current when the response arrives, which gives LAST INTENT WINS
 *    among credential operations themselves.
 *
 * 2. pubGenRef (publication generation)
 *    Advanced by publishTransition (every identity publication). In-flight
 *    passive responses snapshot it and are invalidated the moment it moves.
 *
 * 3. pendingCredRef (in-flight credential count)
 *    Raised at credential-op start, lowered in a finally. A passive probe may
 *    publish only while no credential operation is pending, so a probe that
 *    started around a credential intent can never supersede that intent.
 *
 * Passive responses (the initial /auth/me probe, refreshUser) NEVER advance
 * authority. They publish only if, at resolve time:
 *     pubgen snapshot is current  (no newer publication happened)
 *   AND credgen snapshot is current (no newer credential op started)
 *   AND pendingCred === 0           (no credential op is still in flight)
 *
 * CURRENT credential-operation failures reject to the caller (so pages can
 * surface wrong-password / duplicate-user / network errors and must NOT
 * navigate as success). STALE responses — superseded by a newer credential
 * operation — are silently ignored and never throw.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<UserPublicProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [boundaryRevision, setBoundaryRevision] = useState(0);

  const credGenRef = useRef(0);
  const pubGenRef = useRef(0);
  const pendingCredRef = useRef(0);
  // Identity mirror so passive helpers never read a stale render closure.
  const userRef = useRef<UserPublicProfile | null>(null);

  const passiveIsValid = (pubSnapshot: number, credSnapshot: number) =>
    pubSnapshot === pubGenRef.current &&
    credSnapshot === credGenRef.current &&
    pendingCredRef.current === 0;

  /**
   * Full identity-boundary publication — the ONLY place identity is published.
   * ORDER IS LOAD-BEARING: the cache must be empty before a new identity is
   * visible, so a child can never read another user's cached rows. There is no
   * await between clear() and publish, so privacy correctness does not depend
   * on React batching. Advancing pubGen invalidates all in-flight passive
   * responses; resolving loading here makes the authoritative operation (not a
   * possibly-stale initial probe) own completion.
   */
  const publishTransition = (nextUser: UserPublicProfile | null) => {
    queryClient.clear();                 // (1) privacy before identity
    pubGenRef.current += 1;              // (2) invalidate in-flight passives
    setIsLoading(false);                 // (3) authoritative op owns completion
    userRef.current = nextUser;
    setUser(nextUser);                   // (4) publish identity
    setBoundaryRevision((r) => r + 1);   // (5) remount identity-dependent children
  };

  // Initial session probe — PASSIVE. It may publish an authenticated session
  // as a real null→user boundary, resolve loading for anonymous, or be
  // invalidated entirely by any credential operation. A cleanup flag covers
  // React StrictMode-style effect replay (older duplicate probe must not
  // publish after a newer one does).
  useEffect(() => {
    let active = true;
    const pubSnapshot = pubGenRef.current;
    const credSnapshot = credGenRef.current;
    (async () => {
      try {
        const response = await api.get<{ user: UserPublicProfile }>('/auth/me');
        if (!active || !passiveIsValid(pubSnapshot, credSnapshot)) return;
        if (response.success && response.data?.user) {
          publishTransition(response.data.user); // null → user: full boundary
        } else {
          setIsLoading(false);                  // null → null: no boundary churn
        }
      } catch {
        if (!active || !passiveIsValid(pubSnapshot, credSnapshot)) return;
        setIsLoading(false);                    // anonymous stays anonymous
      }
    })();
    return () => {
      active = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async (email: string, password: string) => {
    const claim = ++credGenRef.current;
    pendingCredRef.current += 1;
    try {
      const response = await api.post<{ user: UserPublicProfile }>('/auth/login', { email, password });
      if (claim !== credGenRef.current) return; // superseded — silently ignore
      if (!response.success || !response.data?.user) {
        // Current but failed (e.g. 2xx with success:false): surface it.
        throw new Error(response.error?.message || 'Login failed');
      }
      publishTransition(response.data.user);
    } catch (err) {
      if (claim !== credGenRef.current) return; // stale failure — ignore
      setIsLoading(false);                      // current failure owns loading
      throw err;                                // propagate to caller
    } finally {
      pendingCredRef.current -= 1;
    }
  };

  // Registration is the SAME identity boundary as login — a brand-new signed
  // identity must not observe any previous user's cached data.
  const register = async (data: { username: string; email: string; password: string; displayName?: string }) => {
    const claim = ++credGenRef.current;
    pendingCredRef.current += 1;
    try {
      const response = await api.post<{ user: UserPublicProfile }>('/auth/register', data);
      if (claim !== credGenRef.current) return;
      if (!response.success || !response.data?.user) {
        throw new Error(response.error?.message || 'Registration failed');
      }
      publishTransition(response.data.user);
    } catch (err) {
      if (claim !== credGenRef.current) return;
      setIsLoading(false);
      throw err;
    } finally {
      pendingCredRef.current -= 1;
    }
  };

  const logout = async () => {
    const claim = ++credGenRef.current;
    pendingCredRef.current += 1;
    try {
      await api.post<null>('/auth/logout');
    } catch {
      // Even if the server call fails (token expired, network error), the UI
      // treats the user as logged out — clear local state below.
    } finally {
      if (claim === credGenRef.current) {
        publishTransition(null);
      }
      pendingCredRef.current -= 1;
    }
  };

  const refreshUser = async () => {
    const pubSnapshot = pubGenRef.current;
    const credSnapshot = credGenRef.current;
    const current = userRef.current;
    try {
      const response = await api.get<{ user: UserPublicProfile }>('/auth/me');
      if (!passiveIsValid(pubSnapshot, credSnapshot)) return;
      if (response.success && response.data?.user) {
        const nextUser = response.data.user;
        if (current && current.id === nextUser.id) {
          // Same-user profile refresh: data update only, NO boundary.
          userRef.current = nextUser;
          setUser(nextUser);
        } else {
          // null → user or user A → user B: full identity boundary.
          publishTransition(nextUser);
        }
      } else if (current) {
        // Was authenticated, now anonymous → logged-out boundary semantics.
        publishTransition(null);
      }
      // anonymous → anonymous: no-op.
    } catch {
      if (!passiveIsValid(pubSnapshot, credSnapshot)) return;
      // Authenticated refresh failure → treated as logged out (boundary), so
      // stale private data cannot linger under a possibly-expired session.
      if (current) publishTransition(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {/* Keying the child subtree by the identity-boundary revision forces a
          remount at every identity transition: query observers, page-local
          state, and SocketProvider all restart against the new identity. */}
      <Fragment key={boundaryRevision}>{children}</Fragment>
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}