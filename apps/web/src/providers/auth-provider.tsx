import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublicProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = async () => {
    try {
      const response = await api.get<{ user: UserPublicProfile }>('/auth/me');
      if (response.success && response.data?.user) {
        setUser(response.data.user);
      }
    } catch (err) {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const login = async (email: string, password: string) => {
    const response = await api.post<{ user: UserPublicProfile }>('/auth/login', { email, password });
    if (response.success && response.data?.user) {
      setUser(response.data.user);
    }
  };

  const register = async (data: { username: string; email: string; password: string; displayName?: string }) => {
    const response = await api.post<{ user: UserPublicProfile }>('/auth/register', data);
    if (response.success && response.data?.user) {
      setUser(response.data.user);
    }
  };

  const logout = async () => {
    await api.post<null>('/auth/logout');
    setUser(null);
  };

  const refreshUser = async () => {
    await fetchUser();
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
      {children}
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