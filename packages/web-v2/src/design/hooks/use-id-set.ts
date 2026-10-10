"use client";

import { useState } from "react";

/** A set of ids ticked on and off: which are in it, one or many put in or taken out, and a reset to any set. */
export function useIdSet(initial: Iterable<string> = []) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set(initial));
  const turn = (some: Iterable<string>, on: boolean) =>
    setIds((prev) => {
      const next = new Set(prev);
      for (const id of some) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  return {
    ids,
    has: (id: string) => ids.has(id),
    toggle: (id: string, on: boolean) => turn([id], on),
    turn,
    reset: (to: Iterable<string> = []) => setIds(new Set(to)),
  };
}
