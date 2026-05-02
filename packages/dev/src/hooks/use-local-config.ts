import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Drive the auth state machine on app mount:
 *  1. Run `hydrateFromDisk` once — reads disk config + keychain, transitions
 *     `hydrating → authenticated|unauthenticated`. The store handles the
 *     v0.1.20 self-heal (resolveApiBase) and persistence internally.
 *  2. Subscribe to `phase` so an `expire` transition (server 401 → store
 *     dispatch) bounces the user to /login. Navigation lives outside the
 *     store because router state is component-scoped.
 */
export function useLocalConfig() {
  const navigate = useNavigate();
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void useAuthStore.getState().hydrateFromDisk();
  }, []);

  useEffect(() => {
    return useAuthStore.subscribe((state, prev) => {
      if (state.phase === "expired" && prev.phase !== "expired") {
        navigate("/login", { replace: true });
      }
    });
  }, [navigate]);
}
