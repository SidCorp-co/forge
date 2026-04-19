'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/api/auth-api';

interface User {
  id: number;
  username: string;
  email: string;
  chatLogAccess?: boolean;
  isCEO?: boolean;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function setJwtCookie(token: string | null) {
  if (token) {
    document.cookie = `forge-jwt=${token}; path=/; samesite=lax; max-age=2592000`;
  } else {
    document.cookie = 'forge-jwt=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const jwt = localStorage.getItem('jwt');
    if (!jwt) {
      setIsLoading(false);
      return;
    }
    authApi.verify(jwt)
      .then((data) => {
        setUser(data);
        setToken(jwt);
        setJwtCookie(jwt);
      })
      .catch(() => {
        localStorage.removeItem('jwt');
        setJwtCookie(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const data = await authApi.login(identifier, password);
    localStorage.setItem('jwt', data.jwt);
    setJwtCookie(data.jwt);
    setToken(data.jwt);
    setUser(data.user);
  }, []);

  const register = useCallback(async (username: string, email: string, password: string) => {
    const data = await authApi.register(username, email, password);
    localStorage.setItem('jwt', data.jwt);
    setJwtCookie(data.jwt);
    setToken(data.jwt);
    setUser(data.user);
  }, []);

  const router = useRouter();

  const logout = useCallback(() => {
    localStorage.removeItem('jwt');
    setJwtCookie(null);
    setToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth: AuthState = {
  user: null,
  token: null,
  isLoading: true,
  login: async () => {},
  register: async () => {},
  logout: () => {},
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  return ctx ?? defaultAuth;
}
