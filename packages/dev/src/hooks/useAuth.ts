import { useAuthStore, type AuthPhase, type AuthState } from "@/stores/auth-store";

export type { AuthPhase, AuthState };

interface UseAuthBase {
  phase: AuthPhase;
  coreUrl: string | null;
  deviceId: string | null;
  token: string | null;
  login: ReturnType<typeof useAuthStore.getState>["login"];
  logout: ReturnType<typeof useAuthStore.getState>["logout"];
  expire: ReturnType<typeof useAuthStore.getState>["expire"];
  setDeviceId: ReturnType<typeof useAuthStore.getState>["setDeviceId"];
  hydrateFromDisk: ReturnType<typeof useAuthStore.getState>["hydrateFromDisk"];
}

/**
 * Selector hook over the auth state machine. Components inside `<RequireAuth>`
 * can `if (auth.phase !== 'authenticated') return null` and the `coreUrl` /
 * `token` / `deviceId` reads below will be non-null at the type level.
 */
export function useAuth(): UseAuthBase {
  const state = useAuthStore();
  const coreUrl =
    state.phase === "authenticated" || state.phase === "expired"
      ? state.coreUrl
      : state.phase === "unauthenticated"
        ? state.coreUrl
        : null;
  const deviceId =
    state.phase === "authenticated" || state.phase === "expired"
      ? state.deviceId
      : state.phase === "unauthenticated"
        ? state.deviceId
        : null;
  const token = state.phase === "authenticated" ? state.token : null;

  return {
    phase: state.phase,
    coreUrl,
    deviceId,
    token,
    login: state.login,
    logout: state.logout,
    expire: state.expire,
    setDeviceId: state.setDeviceId,
    hydrateFromDisk: state.hydrateFromDisk,
  };
}
