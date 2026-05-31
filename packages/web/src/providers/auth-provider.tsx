'use client';

import type { LoginInput, RegisterInput, User as CoreUser } from '@forge/contracts';

/**
 * The legacy `chatLogAccess` flag remains exposed as an optional field for the
 * existing sidebar reader. There is no system-admin / CEO flag anymore —
 * access is purely owner/member per project.
 */
export type User = CoreUser & {
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

/**
 * Legacy localStorage key — only cleared on mount so users upgrading
 * from a pre-ISS-315 build don't carry around a stale token forever.
 * The refresh token now rides an HttpOnly cookie set by the backend on
 * /auth/local + /auth/refresh and cleared by /auth/logout.
 */
const LEGACY_REFRESH_TOKEN_KEY = 'forge_refresh_token';

function clearLegacyRefreshToken() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // On mount, hydrate from /auth/me (cookie may be set from a prior session).
  useEffect(() => {
    let cancelled = false;
    // Burn any pre-ISS-315 token from localStorage on cold start. The
    // refresh token now lives in an HttpOnly cookie; nothing on the
    // client should ever read or write the legacy key again.
    clearLegacyRefreshToken();
    authApi
      .me()
      .then((me) => {
        if (!cancelled) setUser({ ...me });
      })
      .catch((err) => {
        if (cancelled) return;
        // Unauthenticated on mount is the common case on first load.
        if (!(err instanceof ApiError && err.status === 401)) {
          // Log unexpected errors; do not block render.
          console.warn('auth hydration failed', err);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    await authApi.login(input);
    // The backend now sets the HttpOnly refresh cookie itself; we no longer
    // touch localStorage. /auth/me returns the canonical user shape (includes
    // createdAt) — use it as the source of truth.
    const me = await authApi.me();
    setUser({ ...me });
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
