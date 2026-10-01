// Which Issues-list URL params the assistant last set, and to what (ISS-47). The list's toolbar reads
// it to show those filters in the assistant's orange; a param the person has since changed no longer
// matches its mark, so it reads as the person's own without anything having to clear the mark.

import { useSyncExternalStore } from "react";

let marks: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export const assistantFilters = {
  /** Record what one applied action set; `replace` forgets every earlier mark first. */
  mark(set: Record<string, string>, replace: boolean) {
    const next = new Map(replace ? [] : marks);
    for (const [param, value] of Object.entries(set)) next.set(param, value);
    marks = next;
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => marks,
};

/** True where the assistant set `param` to exactly `value`. */
export function useAssistantSetFilter(): (param: string, value: string) => boolean {
  const current = useSyncExternalStore(assistantFilters.subscribe, assistantFilters.get, assistantFilters.get);
  return (param, value) => value !== "" && current.get(param) === value;
}
