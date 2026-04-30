import { configureApi, unregisterDesktop } from "@/lib/api";
import { invoke } from "@/hooks/use-tauri-ipc";
import { Sentry } from "@/lib/sentry";
import { useAppStore } from "@/stores/app-store";
import type { AppConfig } from "@/lib/types";

interface ClearAuthOpts {
  /**
   * `true` for an explicit user-initiated logout — also un-pairs the desktop
   * device record on the core. `false` (default) for involuntary expiry,
   * where we want to keep the device pairing intact so re-login from the
   * same machine doesn't churn another row.
   */
  unregisterDesktop?: boolean;
}

/**
 * Single source of truth for "wipe local auth state". Both the explicit
 * logout button (`useLogout`) and the API client's auth-expired handler
 * call this. Keeping the two paths converged closes a long-standing gap
 * where explicit logout left the keychain JWT behind, so a fresh launch
 * re-hydrated the dead token from `load_user_jwt` and bounced the user.
 *
 * Failure modes are surfaced to Sentry rather than silently swallowed —
 * if `clear_user_jwt` fails, the next launch will reproduce the bug we
 * are trying to prevent, and we want that visible.
 */
export async function clearAuthState(opts: ClearAuthOpts = {}): Promise<void> {
  const cur = useAppStore.getState().config;
  if (opts.unregisterDesktop && cur.deviceId) {
    try {
      await unregisterDesktop(cur.deviceId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { auth_phase: "unregister_desktop" },
        level: "warning",
      });
    }
  }
  const cleared: AppConfig = { ...cur, authToken: "" };
  useAppStore.getState().setConfig(cleared);
  configureApi(cur.coreUrl, "");
  try {
    await invoke("save_config", { config: cleared });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth_phase: "save_config" },
      level: "warning",
    });
  }
  try {
    await invoke("clear_user_jwt");
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth_phase: "clear_user_jwt" },
      level: "error",
    });
  }
  Sentry.setUser(null);
}
