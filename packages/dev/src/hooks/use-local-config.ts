import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { configureApi } from "@/lib/api";
import { setAuthExpiredHandler } from "@/lib/api/client";
import type { AppConfig } from "@/lib/types";

export function useLocalConfig() {
  const { config, setConfig } = useAppStore();
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    invoke<AppConfig>("get_config").then((diskConfig) => {
      if (diskConfig) {
        setConfig(diskConfig);
        configureApi(diskConfig.coreUrl, diskConfig.authToken);
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
