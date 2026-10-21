'use client';

import type { LoginInput, MeResponse, RegisterInput } from '@forge/contracts';

/**
 * The legacy `chatLogAccess` flag remains exposed as an optional field for the
 * readers carried over from v1. There is no system-admin / CEO flag anymore —
 * access is purely owner/member per project. Based on `MeResponse` so settings
 * surfaces can branch on `hasPassword` / `oauthProviders` (SSO reauth).
 */
export type User = MeResponse & {
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
import { readerInitials } from '@forge/contracts/person-name';
import { authApi } from '@/lib/api/auth-api';
import { ApiError } from '@/lib/api/client';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  /** Why the account could not be read, where Forge did not answer that the person is signed out
   *  (ISS-1228): a lost connection or a server failure is not a sign-out. Null once read or signed out. */
  failure: unknown;
  /** Read the account again. */
  retry: () => void;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  /** Saves the name other members read, and every surface reading `user` follows it. */
  setDisplayName: (displayName: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Only Forge answering 401 says a person is signed out; anything else left the question unanswered. */
function signedOut(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Hydrate from /auth/me (the cookie may be set from a prior session), and again on each retry.
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((me) => {
        if (cancelled) return;
        setUser({ ...me });
        setFailure(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (signedOut(err)) {
          setFailure(null);
          return;
        }
        console.warn('auth hydration failed', err);
        setFailure(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // A read the connection cut is read again once the browser says the connection is back.
  useEffect(() => {
    if (!failure) return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failure, retry]);

  const login = useCallback(async (input: LoginInput) => {
    await authApi.login(input);
    // The backend sets the HttpOnly refresh cookie itself; we no longer touch
    // localStorage. /auth/me returns the canonical user shape — source of truth.
    const me = await authApi.me();
    setUser({ ...me });
    setFailure(null);
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

  const setDisplayName = useCallback(async (displayName: string | null) => {
    const saved = await authApi.setDisplayName(displayName);
    setUser((u) => (u ? { ...u, displayName: saved.displayName } : u));
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, failure, retry, login, register, logout, setDisplayName }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth: AuthState = {
  user: null,
  isLoading: true,
  failure: null,
  retry: () => {},
  login: async () => {},
  register: async () => {},
  logout: async () => {},
  setDisplayName: async () => {},
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  return ctx ?? defaultAuth;
}

export function useUserInitials(): string | undefined {
  const { user } = useAuth();
  return user ? readerInitials(user.id, user.id, user.displayName) : undefined;
}
