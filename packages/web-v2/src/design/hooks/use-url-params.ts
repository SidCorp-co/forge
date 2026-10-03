"use client";

import { useCallback } from "react";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";

export type UrlPatch = Record<string, string | null | undefined>;

/** Writes `patch` over the current query (`null` or `""` deletes a key), keeping every other key. */
export function writeUrlParams(patch: UrlPatch): void {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  const qs = next.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  notifyLocationChange();
}

export function useUrlParams(): [URLSearchParams, (patch: UrlPatch) => void] {
  const search = useLocationSearch();
  const set = useCallback((patch: UrlPatch) => writeUrlParams(patch), []);
  return [new URLSearchParams(search), set];
}

/** One enumerated URL param: an unknown value reads as the default, and the default is not written. */
export function useUrlChoice<T extends string>(
  name: string,
  values: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [params, set] = useUrlParams();
  const raw = params.get(name);
  const value = (values as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  const write = useCallback((next: T) => set({ [name]: next === fallback ? null : next }), [set, name, fallback]);
  return [value, write];
}
