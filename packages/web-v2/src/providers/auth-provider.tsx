'use client';

// Ported from `packages/web/src/providers/auth-provider.tsx` (ISS-288).
// Divergence: web-v2 has NO login page yet (deferred to a later phase), so
// `logout()` navigates to the workspace root `/` instead of `/login`, and an
// unauthenticated mount is the expected first-load case — `user` stays `null`
// and pages render an `EmptyState`/`ErrorState` rather than redirect-looping.
import type { LoginInput, RegisterInput, User as CoreUser } from '@forge/contracts';

/**
 * `isCEO` (alias of core `isCeo`) and the legacy `chatLogAccess` flag remain
 * exposed as optional fields. `isCeo` is the canonical core column; `isCEO`
 * is kept for the existing UPPER-case readers carried over from v1.
 */
export type User = CoreUser & {
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
        if (!cancelled) setUser({ ...me, isCEO: me.isCeo });
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
    setUser({ ...me, isCEO: me.isCeo });
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
    // No /login route in web-v2 yet — return to the workspace root.
    router.push('/');
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
