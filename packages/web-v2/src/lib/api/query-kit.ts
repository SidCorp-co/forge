"use client";

// The two shapes every feature's hooks repeat: a keyed read that waits for its key, and a write that
// shows the answer it gets and has the reads it touched read again. A feature keeps its own key
// factory and names its reads and writes; this file owns only the wiring between them.

import { type QueryKey, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

const known = (part: unknown) => part !== undefined && part !== null && part !== "";

/**
 * One read under `queryKey`: off until every part of the key is known (a missing part keys as ""),
 * fresh for `staleTime`. Spread more options over it where a read needs them.
 */
export function readOf<T>(queryKey: readonly unknown[], queryFn: () => Promise<T>, staleTime = 15_000) {
  return queryOptions<T, Error, T, QueryKey>({ queryKey: queryKey.map((part) => part ?? ""), queryFn, enabled: queryKey.every(known), staleTime });
}

type Keys<V> = readonly QueryKey[] | ((vars: V) => readonly QueryKey[]);

export interface WriteEffects<V, D> {
  /** Where the answer is shown at once: the read it replaces. */
  shows?: QueryKey | ((vars: V) => QueryKey);
  /** The part of the answer `shows` holds, when it is not the whole answer. */
  shown?: (answer: D) => unknown;
  /** The reads that are stale once the write settles, success or not. */
  touches?: Keys<V>;
}

/** A write whose answer replaces the read `shows` names, after which every read in `touches` is read again. */
export function useWrite<V = void, D = unknown>(mutationFn: (vars: V) => Promise<D>, { shows, shown = (answer) => answer, touches = [] }: WriteEffects<V, D> = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (answer: D, vars: V) => {
      if (shows && known(answer)) qc.setQueryData(typeof shows === "function" ? shows(vars) : shows, shown(answer));
    },
    // started, not awaited: a returned refetch would keep the write pending until every read came back
    onSettled: (_answer, _error, vars: V) => {
      for (const queryKey of typeof touches === "function" ? touches(vars) : touches) void qc.invalidateQueries({ queryKey });
    },
  });
}
