"use client";

import { useEffect } from "react";
import { usePerTabState } from "@/lib/utils/use-persisted-state";
import { type ModeRoutes, NO_MODE_ROUTES, rememberRoute } from "./mode";

export const MODE_ROUTES_KEY = "web-v2:mode-routes";

// cm:why a convenience only: storage that is blocked or cleared leaves each mode opening on its own root, which is still a correct place to land
export function useModeMemory(route: string): ModeRoutes {
  const [routes, setRoutes] = usePerTabState<ModeRoutes>(MODE_ROUTES_KEY, NO_MODE_ROUTES);
  useEffect(() => {
    setRoutes((prev) => rememberRoute(prev ?? NO_MODE_ROUTES, route));
  }, [route, setRoutes]);
  return routes ?? NO_MODE_ROUTES;
}
