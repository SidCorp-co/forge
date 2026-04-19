import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "./use-tauri-ipc";
import { configureApi } from "@/lib/api";
import type { AppConfig } from "@/lib/types";

export function useLocalConfig() {
  const { config, setConfig } = useAppStore();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    invoke<AppConfig>("get_config").then((diskConfig) => {
      if (diskConfig) {
        setConfig(diskConfig);
        configureApi(diskConfig.strapiUrl, diskConfig.authToken);
      }
    });
  }, [setConfig]);

  async function saveConfig(newConfig: AppConfig) {
    setConfig(newConfig);
    configureApi(newConfig.strapiUrl, newConfig.authToken);
    await invoke("save_config", { config: newConfig });
  }

  return { config, saveConfig };
}
