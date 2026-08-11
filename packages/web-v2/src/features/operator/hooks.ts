"use client";

import { useQuery } from "@tanstack/react-query";
import { operatorApi } from "./api";
import type { OperatorWhoami } from "./types";

/** `initialData` is the verdict the RSC gate already resolved for this render
 *  (app/admin/layout.tsx), so a cold load costs no second round-trip and the
 *  rail paints with the page instead of flashing a skeleton. */
export function useOperatorWhoami(initialData?: OperatorWhoami) {
  return useQuery({
    queryKey: ["operator", "whoami"],
    queryFn: operatorApi.whoami,
    staleTime: 60_000,
    retry: false,
    initialData,
  });
}
