"use client";

import { useCallback } from "react";
import { usePersistedState } from "@/lib/utils/use-persisted-state";

export const LIST_DENSITIES = ["compact", "comfortable"] as const;
export type ListDensity = (typeof LIST_DENSITIES)[number];

// Compact is the 36px single line the UI's row rule asks for.
export const DEFAULT_DENSITY: ListDensity = "compact";

export const DENSITY_LABELS: Record<ListDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
};

export const LIST_DENSITY_KEY = "web-v2:issues-list-density";

export function densityOf(stored: unknown): ListDensity {
  return (LIST_DENSITIES as readonly unknown[]).includes(stored) ? (stored as ListDensity) : DEFAULT_DENSITY;
}

export function useListDensity(): [ListDensity, (next: ListDensity) => void] {
  const [stored, setStored] = usePersistedState<unknown>(LIST_DENSITY_KEY, DEFAULT_DENSITY);
  const set = useCallback((next: ListDensity) => setStored(next), [setStored]);
  return [densityOf(stored), set];
}
