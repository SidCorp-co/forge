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
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    invoke<AppConfig>("get_config").then(async (diskConfig) => {
      if (!diskConfig) return;
      setConfig(diskConfig);
      // Self-heal: users who logged in on <= v0.1.20 stored the WEB URL in
      // config.coreUrl (the URL they typed) instead of the resolved API
      // origin. On subdomain-split deploys every /api/* call from that
      // baseUrl 404s. Resolve via /.well-known/forge-config.json on every
      // launch — single-origin deploys return the same URL (cheap) and
      // stale subdomain-split configs heal silently. Persist the resolved
      // URL so subsequent launches skip the probe entirely.
      const resolved = await resolveApiBase(diskConfig.coreUrl);
      configureApi(resolved, diskConfig.authToken);
      if (resolved && resolved !== diskConfig.coreUrl) {
        const healed: AppConfig = { ...diskConfig, coreUrl: resolved };
        setConfig(healed);
        await invoke("save_config", { config: healed }).catch(() => {/* ignore */});
      }
    });

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
      navigate("/login", { replace: true });
    });
    return () => setAuthExpiredHandler(null);
  }, [setConfig, navigate]);

  async function saveConfig(newConfig: AppConfig) {
    setConfig(newConfig);
    configureApi(newConfig.coreUrl, newConfig.authToken);
    await invoke("save_config", { config: newConfig });
  }

  return { config, saveConfig };
}
