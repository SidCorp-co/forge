import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { configureApi } from "@/lib/api";
import { resolveApiBase } from "@/lib/api-discovery";
import { setAuthExpiredHandler } from "@/lib/api/client";
import type { AppConfig } from "@/lib/types";

export function useLocalConfig() {
  const { config, setConfig } = useAppStore();
  const setConfigReady = useAppStore((s) => s.setConfigReady);
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

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
          return null;
        });
        const cfg: AppConfig = { ...(diskConfig ?? ({} as AppConfig)), authToken: jwt ?? "" };
        console.warn("[auth-trace] hydrate result jwt?=", !!jwt);
        setConfig(cfg);
        // Self-heal: users who logged in on <= v0.1.20 stored the WEB URL in
        // config.coreUrl (the URL they typed) instead of the resolved API
        // origin. On subdomain-split deploys every /api/* call from that
        // baseUrl 404s. Resolve via /.well-known/forge-config.json on every
        // launch — single-origin deploys return the same URL (cheap) and
        // stale subdomain-split configs heal silently. Persist the resolved
        // URL so subsequent launches skip the probe entirely.
        const resolved = await resolveApiBase(cfg.coreUrl);
        configureApi(resolved, cfg.authToken);
        if (resolved && resolved !== cfg.coreUrl) {
          const healed: AppConfig = { ...cfg, coreUrl: resolved };
          setConfig(healed);
          await invoke("save_config", { config: healed }).catch(() => {/* ignore */});
        }
      } catch (err) {
        console.warn("[auth-trace] useLocalConfig hydrate threw:", err);
      } finally {
        // Always flip the gate so RequireAuth / LoginPage stop showing the
        // splash even when keychain access fails. A failed hydrate means the
        // user has no JWT — same outcome as logged-out.
        console.warn("[auth-trace] useLocalConfig hydrate: ready");
        setConfigReady(true);
      }
    })();

    // ISS-280: when any API call comes back 401 INVALID_TOKEN/UNAUTHENTICATED,
    // wipe the in-memory auth and bounce the user to /login. Avoids the
    // "every action silently fails" stuck state after a server JWT_SECRET
    // rotation or an expired token.
    setAuthExpiredHandler(() => {
      const cur = useAppStore.getState().config;
      const cleared: AppConfig = { ...cur, authToken: "" };
      setConfig(cleared);
      configureApi(cur.coreUrl, "");
      invoke("save_config", { config: cleared }).catch(() => {/* ignore */});
      // Drop the keychain JWT too — otherwise the next launch would
      // re-hydrate the expired token from `load_user_jwt` and bounce
      // the user right back into the loop.
      invoke("clear_user_jwt").catch(() => {/* ignore */});
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
