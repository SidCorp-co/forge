"use client";

import { useCallback } from "react";
import { notifyLocationChange, useLocationSearch } from "@/lib/utils/use-location-search";

type UrlPatch = Record<string, string | null | undefined>;

/** Writes `patch` over the current query (`null` or `""` deletes a key), keeping every other key and the anchor. */
export function writeUrlParams(patch: UrlPatch): void {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  const qs = next.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
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

/** A set of flags in one URL param (`?f=you,stuck`): the ones on, and a toggle that writes the rest back. */
export function useUrlFlags<T extends string>(values: readonly T[], name = "f"): [Set<T>, (flag: T) => void] {
  const [params, set] = useUrlParams();
  const on = new Set((params.get(name) ?? "").split(",").filter((x): x is T => (values as readonly string[]).includes(x)));
  const toggle = (flag: T) => {
    const next = new Set(on);
    if (!next.delete(flag)) next.add(flag);
    set({ [name]: [...next].join(",") || null });
  };
  return [on, toggle];
}
