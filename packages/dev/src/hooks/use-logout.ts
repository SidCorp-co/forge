import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app-store";
import { configureApi, unregisterDesktop } from "@/lib/api";
import { invoke } from "@/hooks/use-tauri-ipc";
import type { AppConfig } from "@/lib/types";

export function useLogout() {
  const navigate = useNavigate();
  const { config, setConfig } = useAppStore();

  return async () => {
    // Unregister desktop from Strapi before clearing credentials
    try {
      await unregisterDesktop(config.deviceId || "");
    } catch { /* ignore */ }

    const updated: AppConfig = { ...config, authToken: "" };
    setConfig(updated);
    configureApi(config.coreUrl, "");
    await invoke("save_config", { config: updated });
    navigate("/login", { replace: true });
  };
}
