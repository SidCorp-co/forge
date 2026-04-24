'use client';

import type { LoginInput, RegisterInput, User as CoreUser } from '@forge/contracts';

/**
 * Legacy Strapi-era fields surfaced as optional so F2-bound call sites
 * (dashboards, CEO pages, sidebar flags) keep compiling. Every reader falls
 * back to the `undefined` branch. These keys are removed once F2 finishes
 * the feature-module rewire and ISS-211 introduces the real `roles` model.
 */
export type User = CoreUser & {
  username?: string;
  isCEO?: boolean;
  chatLogAccess?: boolean;
};
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { authApi } from '@/lib/api/auth-api';
import { ApiError } from '@/lib/api/client';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const REFRESH_TOKEN_KEY = 'forge_refresh_token';

function storeRefreshToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(REFRESH_TOKEN_KEY, token);
  else window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // On mount, hydrate from /auth/me (cookie may be set from a prior session).
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((err) => {
        if (cancelled) return;
        // Unauthenticated on mount is the common case on first load.
        if (!(err instanceof ApiError && err.status === 401)) {
          // Log unexpected errors; do not block render.
          console.warn('auth hydration failed', err);
        }
        storeRefreshToken(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    const res = await authApi.login(input);
    storeRefreshToken(res.refreshToken);
    // /auth/me returns the canonical shape including createdAt — use it as the
    // source of truth rather than constructing a partial user from the login
    // response body.
    const me = await authApi.me();
    setUser(me);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    await authApi.register(input);
    // Registration does not sign the user in — caller should navigate to /login.
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Server-side logout is best-effort; always clear client state.
    }
    storeRefreshToken(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth: AuthState = {
  user: null,
  isLoading: true,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  return ctx ?? defaultAuth;
}
