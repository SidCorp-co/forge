import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { configureApi } from "@/lib/api";
import { invoke } from "@/hooks/use-tauri-ipc";
import { FormInput } from "@/components/ui/form-input";
import type { AppConfig } from "@/lib/types";

export function LoginPage() {
  const { config, setConfig } = useAppStore();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  const [coreUrl, setStrapiUrl] = useState(config.coreUrl || "http://localhost:8080");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Redirect if already logged in
  if (config.authToken) {
    navigate(from, { replace: true });
    return null;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const url = coreUrl.replace(/\/$/, "");
      const res = await fetch(`${url}/api/auth/local`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message || "Invalid credentials");
        return;
      }
      const updated: AppConfig = {
        coreUrl: url,
        authToken: data.jwt,
        projects: config.projects,
        deviceId: config.deviceId || "",
      };
      setConfig(updated);
      configureApi(url, data.jwt);
      await invoke("save_config", { config: updated });
      navigate(from, { replace: true });
    } catch {
      setError("Cannot connect to server. Is Strapi running?");
    } finally {
      setLoading(false);
    }
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
            <label className="mb-1 block text-xs text-gray-500">Server</label>
            <FormInput
              type="text"
              value={coreUrl}
              onChange={(e) => setStrapiUrl(e.target.value)}
            />
          </div>

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
