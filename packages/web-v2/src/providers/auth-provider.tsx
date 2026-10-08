'use client';

import type { LoginInput, RegisterInput } from '@forge/contracts/requests';
import type { MeResponse } from '@forge/contracts/responses';

/** The signed-in user; settings surfaces branch on `hasPassword` / `oauthProviders` (SSO reauth). */
export type User = MeResponse;
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
import { onSessionEnded } from '@/lib/api/session-ended';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  /** Core answered that the browser's session ended: the person is signed out and told so quietly. */
  sessionEnded: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  const router = useRouter();

  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
        setSessionEnded(true);
      }),
    [],
  );

  // On mount, hydrate from /auth/me (cookie may be set from a prior session).
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (!cancelled) setUser({ ...me });
      })
      .catch((err) => {
        if (cancelled) return;
        // Unauthenticated on mount is the common case on first load — login is
        // deferred, so we leave user=null and let pages render an empty/error
        // state. Only log genuinely unexpected (non-401) failures.
        if (!(err instanceof ApiError && err.status === 401)) {
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
    // The backend sets the HttpOnly refresh cookie itself; we no longer touch
    // localStorage. /auth/me returns the canonical user shape — source of truth.
    const me = await authApi.me();
    setSessionEnded(false);
    setUser({ ...me });
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    await authApi.register(input);
    // Registration does not sign the user in.
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
    <AuthContext.Provider value={{ user, isLoading, sessionEnded, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth: AuthState = {
  user: null,
  isLoading: true,
  sessionEnded: false,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  return ctx ?? defaultAuth;
}
