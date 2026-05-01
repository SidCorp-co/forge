import { create } from "zustand";
import { invoke } from "@/hooks/use-tauri-ipc";
import { Sentry } from "@/lib/sentry";
import type { AppConfig } from "@/lib/types";

// Discriminated state machine that owns *every* renderer-side piece of auth
// state. The pre-v0.1.28 design split this across the Zustand `config` slice,
// module-level mutables in `lib/api/client.ts`, and the OS keychain. Every
// transition (hydrate, login, expire, logout) had to manually keep all three
// in sync — and the v0.1.25/26/27 race chain proved that a single reorder in
// `useLocalConfig` was enough to silently break the contract.
//
// Now: callers go through one of the action methods below. Each method
// performs the side-effects (cache invalidation + keychain IPC + save_config)
// in a fixed order, then updates state. Reordering at the call site is no
// longer possible because callers don't touch the side-effects directly.
export type AuthState =
  | { phase: "hydrating" }
  | { phase: "unauthenticated"; coreUrl: string | null; deviceId: string | null }
  | { phase: "authenticated"; coreUrl: string; token: string; deviceId: string }
  | { phase: "expired"; coreUrl: string; deviceId: string };

export type AuthPhase = AuthState["phase"];

export interface AuthActions {
  /** Initial keychain hydrate. Transitions hydrating → authenticated|unauthenticated. */
  hydrateFromDisk: () => Promise<void>;
  /** Successful login. Transitions unauthenticated|expired → authenticated. */
  login: (input: { coreUrl: string; token: string; deviceId?: string }) => Promise<void>;
  /** Server rejected the JWT. Transitions authenticated → expired. */
  expire: () => void;
  /** Explicit user logout. Transitions authenticated|expired → unauthenticated. */
  logout: (opts?: { unregisterDesktop?: boolean }) => Promise<void>;
  /**
   * Update the deviceId without changing phase. Used by the Settings pair-device
   * flow (which runs while authenticated). Lazy-loaded into the unauthenticated
   * branch as well so future re-pair-then-login flows stay correct.
   */
  setDeviceId: (deviceId: string) => void;
}

type AuthStore = AuthState & AuthActions;

const LEGAL: Record<AuthPhase, ReadonlySet<AuthPhase>> = {
  hydrating: new Set(["unauthenticated", "authenticated"]),
  unauthenticated: new Set(["authenticated"]),
  authenticated: new Set(["expired", "unauthenticated"]),
  expired: new Set(["unauthenticated", "authenticated"]),
};

function assertLegal(from: AuthPhase, to: AuthPhase): void {
  if (LEGAL[from].has(to)) return;
  const msg = `Illegal auth transition: ${from} → ${to}`;
  Sentry.captureMessage(msg, {
    level: "warning",
    tags: { auth_phase: "illegal_transition" },
    extra: { from, to },
  });
  throw new Error(msg);
}

function breadcrumb(message: string, data?: Record<string, unknown>): void {
  Sentry.addBreadcrumb({ category: "auth", level: "info", message, data });
}

// Lazy imports to break the auth-store ↔ api-client circular reference. The
// store is the only legitimate caller of these cache invalidators.
async function clearApiCaches(): Promise<void> {
  const [{ clearProjectIdCache }, { clearDeviceTokenCache }] = await Promise.all([
    import("@/lib/api/client"),
    import("@/lib/api/jobs"),
  ]);
  clearProjectIdCache();
  clearDeviceTokenCache();
}

async function unregisterDesktopBestEffort(deviceId: string | null | undefined): Promise<void> {
  if (!deviceId) return;
  try {
    const { unregisterDesktop } = await import("@/lib/api");
    await unregisterDesktop(deviceId);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth_phase: "unregister_desktop" },
      level: "warning",
    });
  }
}

async function persistKeychain(token: string | null): Promise<void> {
  // Token write/clear is best-effort — see plan §"Risks": a failed keychain
  // write means the next reload re-prompts login, which is acceptable.
  try {
    if (token) await invoke("store_user_jwt", { token });
    else await invoke("clear_user_jwt");
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth_phase: token ? "store_user_jwt" : "clear_user_jwt" },
      level: token ? "warning" : "error",
    });
  }
}

async function saveConfigBestEffort(config: AppConfig): Promise<void> {
  try {
    await invoke("save_config", { config });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { auth_phase: "save_config" },
      level: "warning",
    });
  }
}

function buildDiskConfig(snapshot: {
  coreUrl: string;
  token: string;
  deviceId: string;
}, base: Partial<AppConfig>): AppConfig {
  // The Rust serde model deliberately drops `auth_token` on save (ADR 0004),
  // so persisting it here is a no-op on disk — but we include it to match
  // the type contract. The user JWT lives in the OS keychain.
  return {
    coreUrl: snapshot.coreUrl,
    authToken: snapshot.token,
    deviceId: snapshot.deviceId,
    projects: base.projects ?? {},
    projectsRoot: base.projectsRoot,
    skillLibrary: base.skillLibrary,
    mcpLibrary: base.mcpLibrary,
  };
}

async function readDeviceSettings(): Promise<Partial<AppConfig>> {
  // The renderer-side device settings (projects, projectsRoot, skillLibrary,
  // mcpLibrary) live in app-store's `deviceSettings` slice once hydrate
  // completes. Login/logout fire before/after that hydrate window in normal
  // flows, so reading the slice synchronously is fine.
  const { useAppStore } = await import("./app-store");
  return useAppStore.getState().deviceSettings;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  phase: "hydrating" as const,

  hydrateFromDisk: async () => {
    const cur = get();
    if (cur.phase !== "hydrating") return; // idempotent: only run once
    const start = performance.now();
    breadcrumb("hydrate:start");

    let diskConfig: AppConfig | null = null;
    let jwt: string | null = null;
    try {
      diskConfig = await invoke<AppConfig>("get_config").catch(() => null);
      jwt = await invoke<string | null>("load_user_jwt").catch((err) => {
        Sentry.captureException(err, {
          tags: { auth_phase: "load_user_jwt" },
          level: "warning",
        });
        return null;
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { auth_phase: "hydrate" }, level: "error" });
    }

    const diskCoreUrl = diskConfig?.coreUrl ?? "";
    const diskDeviceId = diskConfig?.deviceId ?? "";

    // Hydrate the device settings slice in parallel — projects/projectsRoot
    // need to be available before the WS/skill-sync hooks fire on
    // authenticated state.
    if (diskConfig) {
      try {
        const { useAppStore } = await import("./app-store");
        useAppStore.getState().setDeviceSettings({
          projects: diskConfig.projects ?? {},
          projectsRoot: diskConfig.projectsRoot,
          skillLibrary: diskConfig.skillLibrary,
          mcpLibrary: diskConfig.mcpLibrary,
        });
      } catch {
        // ignore — non-fatal, components will read defaults
      }
    }

    breadcrumb("hydrate:result", {
      jwt_present: !!jwt,
      disk_config_present: !!diskConfig,
      disk_core_url: diskCoreUrl || null,
      elapsed_ms: Math.round(performance.now() - start),
    });

    if (!jwt || !diskCoreUrl) {
      assertLegal(cur.phase, "unauthenticated");
      set({
        phase: "unauthenticated",
        coreUrl: diskCoreUrl || null,
        deviceId: diskDeviceId || null,
      });
      breadcrumb("hydrate:ready", { result: "unauthenticated" });
      return;
    }

    // Self-heal: <= v0.1.20 stored the WEB URL in coreUrl. Resolve via
    // /.well-known/forge-config.json so subdomain-split deploys land on the
    // API origin. Single-origin deploys return the same URL unchanged.
    let resolvedCoreUrl = diskCoreUrl;
    try {
      const { resolveApiBase } = await import("@/lib/api-discovery");
      const resolved = await resolveApiBase(diskCoreUrl);
      if (resolved) resolvedCoreUrl = resolved;
    } catch (err) {
      Sentry.captureException(err, { tags: { auth_phase: "resolve_api_base" }, level: "warning" });
    }

    if (diskDeviceId) Sentry.setUser({ id: diskDeviceId });

    await clearApiCaches();
    assertLegal(cur.phase, "authenticated");
    set({
      phase: "authenticated",
      coreUrl: resolvedCoreUrl,
      token: jwt,
      deviceId: diskDeviceId,
    });

    if (resolvedCoreUrl !== diskCoreUrl && diskConfig) {
      // Persist the resolved URL so subsequent launches skip the probe.
      await saveConfigBestEffort({ ...diskConfig, coreUrl: resolvedCoreUrl });
    }

    breadcrumb("hydrate:ready", { result: "authenticated" });
  },

  login: async ({ coreUrl, token, deviceId }) => {
    const cur = get();
    if (cur.phase !== "unauthenticated" && cur.phase !== "expired") {
      assertLegal(cur.phase, "authenticated");
    }
    let finalDeviceId = deviceId ?? "";
    if (!finalDeviceId) {
      if (cur.phase === "unauthenticated") finalDeviceId = cur.deviceId ?? "";
      else if (cur.phase === "expired") finalDeviceId = cur.deviceId;
    }

    // Order: clear caches → set state → write keychain → save_config.
    // The api client reads coreUrl/token from this store, so set state
    // BEFORE the keychain write so any micro-task that races in observes a
    // consistent (coreUrl, token) pair. Keychain failure logs to Sentry
    // but does not roll back — same trade-off as the v0.1.27 LoginPage path.
    await clearApiCaches();
    set({
      phase: "authenticated",
      coreUrl,
      token,
      deviceId: finalDeviceId,
    });
    if (finalDeviceId) Sentry.setUser({ id: finalDeviceId });
    breadcrumb("auth.transition.login", { coreUrl });

    await persistKeychain(token);

    const settings = await readDeviceSettings();
    await saveConfigBestEffort(
      buildDiskConfig({ coreUrl, token, deviceId: finalDeviceId }, settings),
    );
  },

  expire: () => {
    const cur = get();
    if (cur.phase !== "authenticated") {
      // Idempotent: a second 401 dispatched after the first one already
      // demoted to expired must not throw or fire keychain wipes again.
      return;
    }
    breadcrumb("auth.transition.expire", {
      had_token: true,
      core_url: cur.coreUrl,
      device_id: cur.deviceId || null,
    });
    Sentry.captureMessage("auth-expired-handler-fired", {
      level: "warning",
      tags: { auth_phase: "expired" },
      extra: {
        had_token: true,
        core_url: cur.coreUrl,
        device_id: cur.deviceId || null,
      },
    });
    set({
      phase: "expired",
      coreUrl: cur.coreUrl,
      deviceId: cur.deviceId,
      // Explicit undefined: Zustand's default merge would leave the stale
      // `token` field hanging on the new phase shape otherwise.
      token: undefined,
    } as Partial<AuthStore>);
    // Clear keychain in the background — re-login from the same machine
    // should reuse the existing device row but must not re-hydrate the
    // dead JWT on next launch.
    void persistKeychain(null);
  },

  logout: async ({ unregisterDesktop = false } = {}) => {
    const cur = get();
    // Logout is only legal from authenticated|expired. Hydrating /
    // unauthenticated have nothing to log out of.
    if (cur.phase !== "authenticated" && cur.phase !== "expired") {
      const msg = `Illegal auth transition: ${cur.phase} → unauthenticated (logout)`;
      Sentry.captureMessage(msg, {
        level: "warning",
        tags: { auth_phase: "illegal_transition" },
      });
      throw new Error(msg);
    }
    const coreUrl = cur.coreUrl;
    const deviceId = cur.deviceId;

    if (unregisterDesktop) await unregisterDesktopBestEffort(deviceId);

    await clearApiCaches();
    set({
      phase: "unauthenticated",
      coreUrl,
      deviceId,
      token: undefined,
    } as Partial<AuthStore>);
    breadcrumb("auth.transition.logout", { unregisterDesktop });

    await persistKeychain(null);

    const settings = await readDeviceSettings();
    await saveConfigBestEffort(
      buildDiskConfig(
        { coreUrl: coreUrl ?? "", token: "", deviceId: deviceId ?? "" },
        settings,
      ),
    );

    Sentry.setUser(null);
  },

  setDeviceId: (deviceId) => {
    const cur = get();
    if (cur.phase === "authenticated") {
      set({ ...cur, deviceId });
    } else if (cur.phase === "expired") {
      set({ ...cur, deviceId });
    } else if (cur.phase === "unauthenticated") {
      set({ ...cur, deviceId });
    }
    if (deviceId) Sentry.setUser({ id: deviceId });
  },
}));

/** Test-only: reset the store to its initial hydrating state. */
export function _resetAuthStoreForTest(): void {
  useAuthStore.setState({ phase: "hydrating" } as AuthState as AuthStore);
}
