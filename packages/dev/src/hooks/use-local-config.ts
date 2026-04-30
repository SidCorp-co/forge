import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { configureApi } from "@/lib/api";
import { resolveApiBase } from "@/lib/api-discovery";
import { setAuthExpiredHandler } from "@/lib/api/client";
import { clearAuthState } from "@/lib/clear-auth";
import { Sentry } from "@/lib/sentry";
import type { AppConfig } from "@/lib/types";

/**
 * Pure-function hydrate body extracted from `useLocalConfig` so that the
 * call-order invariant (configureApi BEFORE setConfig) can be unit-tested
 * without renderHook (see vitest.config.ts on the dual-React mismatch).
 *
 * The deps argument is the seam: production wiring passes the real
 * implementations; tests pass spies and assert on `mock.invocationCallOrder`.
 */
export interface HydrateLocalConfigDeps {
  invoke: typeof invoke;
  configureApi: typeof configureApi;
  resolveApiBase: typeof resolveApiBase;
  setConfig: (cfg: AppConfig) => void;
  setConfigReady: (ready: boolean) => void;
  Sentry: typeof Sentry;
}

export async function hydrateLocalConfig(deps: HydrateLocalConfigDeps): Promise<void> {
  const hydrateStart = performance.now();
  deps.Sentry.addBreadcrumb({ category: "auth", level: "info", message: "hydrate:start" });
  console.warn("[auth-trace] useLocalConfig hydrate: start");

  try {
    const diskConfig = await deps.invoke<AppConfig>("get_config");
    // ADR 0004: JWT lives in the OS keychain, not config.json — pull it
    // separately and merge into the in-memory config.
    const jwt = await deps.invoke<string | null>("load_user_jwt").catch((err) => {
      console.warn("[auth-trace] load_user_jwt failed:", err);
      deps.Sentry.captureException(err, {
        tags: { auth_phase: "load_user_jwt" },
        level: "warning",
      });
      return null;
    });
    const cfg: AppConfig = { ...(diskConfig ?? ({} as AppConfig)), authToken: jwt ?? "" };
    console.warn("[auth-trace] hydrate result jwt?=", !!jwt);
    deps.Sentry.addBreadcrumb({
      category: "auth",
      level: "info",
      message: "hydrate:result",
      data: {
        jwt_present: !!jwt,
        disk_config_present: !!diskConfig,
        disk_core_url: diskConfig?.coreUrl ?? null,
        elapsed_ms: Math.round(performance.now() - hydrateStart),
      },
    });
    if (cfg.deviceId) {
      deps.Sentry.setUser({ id: cfg.deviceId });
    }
    // ORDER MATTERS — configureApi BEFORE setConfig. Sentry surfaced a
    // regression in v0.1.25 where setConfig published authToken to the store
    // before the api client had its baseUrl, so subscribed components fired
    // React Query refetches against the module-level default localhost:8080.
    // Any operator running a local dev core there returns 401 INVALID_TOKEN,
    // which trips setAuthExpiredHandler and wipes the just-loaded JWT.
    deps.configureApi(cfg.coreUrl, cfg.authToken);
    deps.setConfig(cfg);
    // Self-heal: users who logged in on <= v0.1.20 stored the WEB URL in
    // config.coreUrl. On subdomain-split deploys every /api/* call 404s.
    // Resolve via /.well-known/forge-config.json on each launch — same URL
    // for single-origin deploys, silent heal for split.
    const resolved = await deps.resolveApiBase(cfg.coreUrl);
    if (resolved && resolved !== cfg.coreUrl) {
      deps.configureApi(resolved, cfg.authToken);
      const healed: AppConfig = { ...cfg, coreUrl: resolved };
      deps.setConfig(healed);
      try {
        await deps.invoke("save_config", { config: healed });
      } catch (err) {
        deps.Sentry.captureException(err, {
          tags: { auth_phase: "save_config_heal" },
          level: "warning",
        });
      }
    }
  } catch (err) {
    console.warn("[auth-trace] useLocalConfig hydrate threw:", err);
    deps.Sentry.captureException(err, {
      tags: { auth_phase: "hydrate" },
      level: "error",
    });
  } finally {
    // Always flip the gate so RequireAuth / LoginPage stop showing the splash
    // even when keychain access fails — a failed hydrate has the same outcome
    // as logged-out (no JWT).
    console.warn("[auth-trace] useLocalConfig hydrate: ready");
    deps.Sentry.addBreadcrumb({
      category: "auth",
      level: "info",
      message: "hydrate:ready",
      data: { elapsed_ms: Math.round(performance.now() - hydrateStart) },
    });
    deps.setConfigReady(true);
  }
}

export function useLocalConfig() {
  const { config, setConfig } = useAppStore();
  const setConfigReady = useAppStore((s) => s.setConfigReady);
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    void hydrateLocalConfig({
      invoke,
      configureApi,
      resolveApiBase,
      setConfig,
      setConfigReady,
      Sentry,
    });

    // ISS-280: when any API call comes back 401 INVALID_TOKEN/UNAUTHENTICATED,
    // wipe the in-memory auth and bounce the user to /login. Avoids the
    // "every action silently fails" stuck state after a server JWT_SECRET
    // rotation or an expired token.
    setAuthExpiredHandler(() => {
      const cur = useAppStore.getState().config;
      // The "log out on reload" class of bugs converges here — anything that
      // wipes the JWT (server 401, race in hydrate, etc.) goes through this
      // handler. Capture with current state so a maintainer reading Sentry
      // can tell whether the user *had* a token a moment ago.
      Sentry.captureMessage("auth-expired-handler-fired", {
        level: "warning",
        tags: { auth_phase: "expired" },
        extra: {
          had_token: !!cur.authToken,
          core_url: cur.coreUrl,
          device_id: cur.deviceId || null,
        },
      });
      // Don't unregister the desktop — server says this token is invalid,
      // not that the user wants to drop the device pairing. Re-login from
      // the same machine should reuse the existing device row.
      void clearAuthState({ unregisterDesktop: false }).then(() => {
        navigate("/login", { replace: true });
      });
    });
    return () => setAuthExpiredHandler(null);
  }, [setConfig, navigate]);

  async function saveConfig(newConfig: AppConfig) {
    setConfig(newConfig);
    configureApi(newConfig.coreUrl, newConfig.authToken);
    // Mirror the JWT into the keychain whenever callers update config —
    // keeps the two stores in sync without forcing every call site to
    // know about the keychain. Empty token => clear, matching logout.
    if (newConfig.authToken) {
      await invoke("store_user_jwt", { token: newConfig.authToken }).catch(() => {/* ignore */});
    } else {
      await invoke("clear_user_jwt").catch(() => {/* ignore */});
    }
    await invoke("save_config", { config: newConfig });
  }

  return { config, saveConfig };
}
