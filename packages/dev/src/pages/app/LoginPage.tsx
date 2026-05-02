import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { FormInput } from "@/components/ui/form-input";
import {
  cancelInFlight,
  fetchEnabledProviders,
  signInWithProvider,
  type OAuthProvider,
} from "@/lib/desktop-oauth";
import { clearApiCache, resolveApiBase } from "@/lib/api-discovery";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  const [coreUrl, setStrapiUrl] = useState(auth.coreUrl || "http://localhost:8080");
  // The auth state machine hydrates async on mount, so on first render
  // `auth.coreUrl` is null and the useState initializer falls back to
  // localhost. Sync once when the real value arrives — guarded by `synced`
  // so we don't clobber any URL the user has already started typing.
  const synced = useRef(false);
  useEffect(() => {
    if (!synced.current && auth.coreUrl) {
      synced.current = true;
      setStrapiUrl(auth.coreUrl);
    }
  }, [auth.coreUrl]);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  // Redirect if already logged in. Calling navigate() in the render body is
  // unsupported in React Router 6+; do it from an effect.
  useEffect(() => {
    if (auth.phase === "authenticated") {
      navigate(from, { replace: true });
    }
  }, [auth.phase, from, navigate]);

  // Refresh provider list whenever the server URL changes. Discovery and
  // provider fetch happen inside fetchEnabledProviders → resolveApiBase →
  // probe /.well-known/forge-config.json on the user-typed URL. Empty list
  // silently hides the section so misconfigured / single-origin / older
  // server deploys all degrade gracefully.
  useEffect(() => {
    let cancelled = false;
    const trimmed = coreUrl.replace(/\/+$/, "");
    if (!trimmed) {
      setProviders([]);
      return;
    }
    fetchEnabledProviders(trimmed).then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
      cancelInFlight();
      clearApiCache();
    };
  }, [coreUrl]);

  async function handleOAuth(providerId: OAuthProvider["id"]) {
    setError("");
    setOauthLoading(providerId);
    try {
      const userUrl = coreUrl.replace(/\/+$/, "");
      const { token, user } = await signInWithProvider({ coreUrl: userUrl, provider: providerId });
      const apiUrl = await resolveApiBase(userUrl);
      await auth.login({ coreUrl: apiUrl, token, deviceId: auth.deviceId ?? "" });
      navigate(from, { replace: true });
      void user;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Sign-in with ${providerId} failed`);
    } finally {
      setOauthLoading(null);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const userUrl = coreUrl.replace(/\/$/, "");
      const url = await resolveApiBase(userUrl);
      // packages/core uses { email, password } and returns { token }; legacy
      // Strapi used { identifier, password } and returned { jwt }. Send both
      // identifier shapes and accept either token field for compat.
      const res = await fetch(`${url}/api/auth/local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: identifier, identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error?.message || "Invalid credentials");
        return;
      }
      const token: string = data.token ?? data.jwt;
      if (!token) {
        setError("Auth response missing token");
        return;
      }
      await auth.login({ coreUrl: url, token, deviceId: auth.deviceId ?? "" });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? `Cannot connect to ${coreUrl}: ${err.message}` : `Cannot connect to ${coreUrl}`);
    } finally {
      setLoading(false);
    }
  }

  // Splash until the keychain hydrate finishes, or while the redirect-back
  // effect is about to fire. Showing the form during this window would let
  // a logged-in user briefly see the login screen on every reload.
  if (auth.phase === "hydrating" || auth.phase === "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-xs font-mono uppercase tracking-widest text-gray-400">
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">Forge</h1>
          <p className="mt-2 text-sm text-gray-500">Developer Workstation</p>
        </div>

        <form onSubmit={handleLogin} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4">
            <label className="mb-1 block text-xs text-gray-500">Server URL</label>
            <FormInput
              type="text"
              value={coreUrl}
              onChange={(e) => setStrapiUrl(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-gray-400">
              The same URL you use to open Forge in your browser.
            </p>
          </div>

          {providers.length > 0 && (
            <>
              <div className="mb-4 flex flex-col gap-2">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={oauthLoading !== null}
                    onClick={() => handleOAuth(p.id)}
                    className="w-full rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {oauthLoading === p.id ? `Opening browser…` : p.label}
                  </button>
                ))}
              </div>
              <div className="mb-4 flex items-center gap-3 text-[10px] uppercase tracking-wider text-gray-400">
                <div className="h-px flex-1 bg-gray-200" />
                <span>or</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>
            </>
          )}

          <div className="mb-4">
            <label className="mb-1 block text-xs text-gray-500">Username or email</label>
            <FormInput
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoFocus
            />
          </div>

          <div className="mb-6">
            <label className="mb-1 block text-xs text-gray-500">Password</label>
            <FormInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !identifier || !password}
            className="w-full rounded-lg bg-black py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {loading ? "Connecting..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
