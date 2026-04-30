import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { configureApi } from "@/lib/api";
import { resolveApiBase } from "@/lib/api-discovery";
import { setAuthExpiredHandler } from "@/lib/api/client";
import { Sentry } from "@/lib/sentry";
import type { AppConfig } from "@/lib/types";

export function useLocalConfig() {
  const { config, setConfig } = useAppStore();
  const setConfigReady = useAppStore((s) => s.setConfigReady);
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const hydrateStart = performance.now();
    Sentry.addBreadcrumb({ category: "auth", level: "info", message: "hydrate:start" });
    console.warn("[auth-trace] useLocalConfig hydrate: start");

    (async () => {
      try {
        const diskConfig = await invoke<AppConfig>("get_config");
        // ADR 0004: the user JWT lives in the OS keychain, not config.json.
        // The Rust serde model deliberately drops `auth_token` on
        // save/load, so before v0.1.23 a fresh launch always landed on the
        // login screen. Pull the JWT from the keychain and merge it into
        // the in-memory config.
        const jwt = await invoke<string | null>("load_user_jwt").catch((err) => {
          console.warn("[auth-trace] load_user_jwt failed:", err);
          Sentry.captureException(err, {
            tags: { auth_phase: "load_user_jwt" },
            level: "warning",
          });
          return null;
        });
        const cfg: AppConfig = { ...(diskConfig ?? ({} as AppConfig)), authToken: jwt ?? "" };
        console.warn("[auth-trace] hydrate result jwt?=", !!jwt);
        Sentry.addBreadcrumb({
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
          Sentry.setUser({ id: cfg.deviceId });
        }
        // ORDER MATTERS — configureApi BEFORE setConfig.
        // Sentry surfaced a regression in v0.1.25 where `setConfig` published
        // authToken into the store before the api client had its baseUrl set.
        // Components subscribed to `config.authToken` triggered React Query
        // refetches that hit the module-level default `localhost:8080` (any
        // operator running a local dev core there returns 401 INVALID_TOKEN),
        // which fires `setAuthExpiredHandler` and wipes the just-loaded JWT.
        // Configuring the api client first means the very first render after
        // store update already has the correct baseUrl + token.
        configureApi(cfg.coreUrl, cfg.authToken);
        setConfig(cfg);
        // Self-heal: users who logged in on <= v0.1.20 stored the WEB URL in
        // config.coreUrl (the URL they typed) instead of the resolved API
        // origin. On subdomain-split deploys every /api/* call from that
        // baseUrl 404s. Resolve via /.well-known/forge-config.json on every
        // launch — single-origin deploys return the same URL (cheap) and
        // stale subdomain-split configs heal silently. Persist the resolved
        // URL so subsequent launches skip the probe entirely.
        const resolved = await resolveApiBase(cfg.coreUrl);
        if (resolved && resolved !== cfg.coreUrl) {
          configureApi(resolved, cfg.authToken);
          const healed: AppConfig = { ...cfg, coreUrl: resolved };
          setConfig(healed);
          await invoke("save_config", { config: healed }).catch(() => {/* ignore */});
        }
      } catch (err) {
        console.warn("[auth-trace] useLocalConfig hydrate threw:", err);
        Sentry.captureException(err, {
          tags: { auth_phase: "hydrate" },
          level: "error",
        });
      } finally {
        // Always flip the gate so RequireAuth / LoginPage stop showing the
        // splash even when keychain access fails. A failed hydrate means the
        // user has no JWT — same outcome as logged-out.
        console.warn("[auth-trace] useLocalConfig hydrate: ready");
        Sentry.addBreadcrumb({
          category: "auth",
          level: "info",
          message: "hydrate:ready",
          data: { elapsed_ms: Math.round(performance.now() - hydrateStart) },
        });
        setConfigReady(true);
      }
    })();

    // ISS-280: when any API call comes back 401 INVALID_TOKEN/UNAUTHENTICATED,
    // wipe the in-memory auth and bounce the user to /login. Avoids the
    // "every action silently fails" stuck state after a server JWT_SECRET
    // rotation or an expired token.
    setAuthExpiredHandler(() => {
      const state = useAppStore.getState();
      // Defensive gate (v0.1.26): if the hydrate hasn't finished, any 401 we
      // saw came from a request fired BEFORE the api client knew its real
      // baseUrl/token — wiping auth on that signal turns a stale-route mistake
      // into a forced logout. Ignore and trust the upcoming hydrate.
      if (!state.configReady) {
        Sentry.captureMessage("auth-expired-pre-hydrate-ignored", {
          level: "warning",
          tags: { auth_phase: "expired-ignored" },
        });
        console.warn("[auth-trace] auth-expired ignored (configReady=false)");
        return;
      }
      const cur = state.config;
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
      const cleared: AppConfig = { ...cur, authToken: "" };
      setConfig(cleared);
      configureApi(cur.coreUrl, "");
      invoke("save_config", { config: cleared }).catch(() => {/* ignore */});
      // Drop the keychain JWT too — otherwise the next launch would
      // re-hydrate the expired token from `load_user_jwt` and bounce
      // the user right back into the loop.
      invoke("clear_user_jwt").catch(() => {/* ignore */});
      Sentry.setUser(null);
      navigate("/login", { replace: true });
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
