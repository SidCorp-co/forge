import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useAuth } from "@/hooks/useAuth";
import { FormInput } from "@/components/ui/form-input";
import {
  startPairing,
  type PairingHandle,
  type PairingPhase,
} from "@/lib/pairing";
import { clearApiCache, resolveApiBase } from "@/lib/api-discovery";

function phaseLabel(phase: PairingPhase | null): string {
  switch (phase) {
    case "initializing":
      return "Requesting a pairing code…";
    case "awaiting-approval":
      return "Waiting for approval in your browser…";
    case "consuming-code":
      return "Signing in…";
    case "authenticated":
      return "Done.";
    default:
      return "";
  }
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  const defaultCoreUrl =
    (import.meta.env.VITE_DEFAULT_CORE_URL as string | undefined) || "http://localhost:8080";
  const [coreUrl, setCoreUrl] = useState(auth.coreUrl || defaultCoreUrl);
  const synced = useRef(false);
  useEffect(() => {
    if (!synced.current && auth.coreUrl) {
      synced.current = true;
      setCoreUrl(auth.coreUrl);
    }
  }, [auth.coreUrl]);

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [pairing, setPairing] = useState<PairingHandle | null>(null);
  const [pairingPhase, setPairingPhase] = useState<PairingPhase | null>(null);
  const [pairingError, setPairingError] = useState<string>("");
  const [copyOk, setCopyOk] = useState(false);

  // Cancel any in-flight pairing when the user navigates away (or the URL
  // they typed changes, which invalidates the discovery cache).
  useEffect(() => {
    return () => {
      pairing?.cancel();
      clearApiCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreUrl]);

  useEffect(() => {
    if (auth.phase === "authenticated") {
      navigate(from, { replace: true });
    }
  }, [auth.phase, from, navigate]);

  async function handlePair() {
    setPairingError("");
    setPairingPhase("initializing");
    try {
      const userUrl = coreUrl.replace(/\/+$/, "");
      const handle = await startPairing({
        coreUrl: userUrl,
        onPhase: (p) => setPairingPhase(p),
      });
      setPairing(handle);
      // Open the user's browser to the connect URL. Failure is non-fatal —
      // the URL is still copyable from the UI.
      void openUrl(handle.connectUrl).catch(() => undefined);
      try {
        const { token, user } = await handle.done;
        const apiUrl = await resolveApiBase(userUrl);
        await auth.login({ coreUrl: apiUrl, token, deviceId: auth.deviceId ?? "" });
        navigate(from, { replace: true });
        void user;
      } catch (err) {
        const message = err instanceof Error ? err.message : "pairing failed";
        setPairingError(message);
        setPairing(null);
        setPairingPhase(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "could not request pairing code";
      setPairingError(message);
      setPairing(null);
      setPairingPhase(null);
    }
  }

  function handleCancelPair() {
    pairing?.cancel();
    setPairing(null);
    setPairingPhase(null);
    setPairingError("");
  }

  async function copyCode() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairingCode);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {
      // ignore
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const userUrl = coreUrl.replace(/\/$/, "");
      const url = await resolveApiBase(userUrl);
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
              onChange={(e) => setCoreUrl(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-gray-400">
              The same URL you use to open Forge in your browser.
            </p>
          </div>

          {pairing ? (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">
                Pairing code
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="font-mono text-3xl tracking-widest text-gray-900">
                  {pairing.pairingCode}
                </p>
                <button
                  type="button"
                  onClick={copyCode}
                  className="rounded border border-gray-300 px-2 py-1 text-[10px] uppercase tracking-widest text-gray-600 hover:bg-gray-100"
                >
                  {copyOk ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-3 text-xs text-gray-600">
                Open this URL in a signed-in browser, paste the code, click Approve. We'll log
                you in here automatically.
              </p>
              <a
                href={pairing.connectUrl}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(pairing.connectUrl).catch(() => undefined);
                }}
                className="mt-2 block break-all font-mono text-[11px] text-blue-600 underline"
              >
                {pairing.connectUrl}
              </a>
              <p className="mt-3 text-[11px] text-gray-500">
                {phaseLabel(pairingPhase) || "Waiting…"}
              </p>
              <button
                type="button"
                onClick={handleCancelPair}
                className="mt-3 text-[11px] uppercase tracking-widest text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={pairingPhase !== null}
                onClick={handlePair}
                className="mb-4 w-full rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50"
              >
                {pairingPhase === "initializing"
                  ? "Requesting a pairing code…"
                  : "Sign in via the web"}
              </button>
              {pairingError && (
                <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                  {pairingError}
                </p>
              )}
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
