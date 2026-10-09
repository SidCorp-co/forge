// The list URL params the assistant last set (ISS-47, REQ-41 BC-7), orange until the person changes
// one: a mark is kept while the URL holds the value the assistant wrote, and forgotten for good the
// first time the URL holds anything else, so a value the person later picks by hand is theirs.

import { useEffect, useSyncExternalStore } from "react";
import { useLocationSearch } from "@/lib/utils/use-location-search";

let marks: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const emit = (next: ReadonlyMap<string, string>) => {
  marks = next;
  for (const l of listeners) l();
};

export const assistantFilters = {
  /** Record what one applied action set; `replace` forgets every earlier mark first. */
  mark(set: Record<string, string>, replace: boolean) {
    const next = new Map(replace ? [] : marks);
    for (const [param, value] of Object.entries(set)) next.set(param, value);
    emit(next);
  },
  /** Forget each mark whose param the URL no longer holds at the assistant's value. */
  forgetChanged(search: URLSearchParams) {
    const kept = new Map([...marks].filter(([param, value]) => search.get(param) === value));
    if (kept.size !== marks.size) emit(kept);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => marks,
};

/** True where the assistant set `param` to exactly `value` and the person has not changed it since. */
export function useAssistantSetFilter(): (param: string, value: string) => boolean {
  const current = useSyncExternalStore(assistantFilters.subscribe, assistantFilters.get, assistantFilters.get);
  const search = useLocationSearch();
  useEffect(() => assistantFilters.forgetChanged(new URLSearchParams(search)), [search]);
  return (param, value) => value !== "" && current.get(param) === value;
}
