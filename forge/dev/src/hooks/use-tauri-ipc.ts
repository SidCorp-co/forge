const isTauri = "__TAURI_INTERNALS__" in window;

const STORAGE_KEY = "forge-dev-config";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  // Browser fallback using localStorage
  if (cmd === "get_config") {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as T;
    return { strapiUrl: "http://localhost:1337", authToken: "", projects: {} } as T;
  }
  if (cmd === "save_config" && args?.config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(args.config));
    return null;
  }
  // Browser fallback: mock agent commands for development
  if (cmd === "send_chat") {
    console.warn("[mock IPC] send_chat — Claude CLI not available in browser mode");
    return null;
  }
  if (cmd === "check_forge_issue_skill") return false as T;
  if (cmd === "ensure_forge_issue_skill") return null;
  console.warn(`[mock IPC] ${cmd}`, args);
  return null;
}

export function useTauriIPC() {
  return { invoke, isTauri };
}
