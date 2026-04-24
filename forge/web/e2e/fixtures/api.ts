/**
 * Minimal REST helpers for the E2E spec. Talks directly to `forge/core`
 * without going through the UI — lets the spec set up state (user, project,
 * job event) deterministically in one network round-trip per call.
 *
 * `CORE_API_URL` defaults to `http://localhost:8080/api` (core's dev port).
 * In CI a Next.js rewrite proxies `/api/*` to core so browser requests stay
 * same-origin; fixtures bypass the rewrite by calling core directly.
 */

export const CORE_API_URL = process.env.E2E_CORE_API_URL ?? 'http://localhost:8080/api';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CORE_API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface RegisteredUser {
  userId: string;
  email: string;
  password: string;
}

export async function registerUser(): Promise<RegisteredUser> {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'correct-horse-battery-staple';
  const { userId } = await call<{ userId: string; email: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return { userId, email, password };
}

/**
 * Email verification is a real email-delivered token in production. For E2E
 * we hit a test-only helper on core when one exists, or skip verification
 * and assume the app tolerates unverified users for the happy path. Phase
 * 2.6 leaves this as a TODO — the spec's AC does not require pipeline
 * actions that depend on `assertEmailVerified()`.
 */

export interface LoginResult {
  token: string;
  refreshToken: string;
}

/** Login via REST to capture tokens; the UI-driven login step in the spec
 *  exercises the visible form separately. */
export async function loginUser(email: string, password: string): Promise<LoginResult> {
  return call<LoginResult>('/auth/local', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function createProject(token: string, slug: string, name: string): Promise<{ id: string; slug: string }> {
  return call<{ id: string; slug: string }>('/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug, name }),
  });
}
