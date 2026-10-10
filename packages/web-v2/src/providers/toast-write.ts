
// The write most features repeat: the reads it touches are read again on success, what it did is
// toasted, and a refusal is toasted under the feature's title in core's own words.

import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "./toast-provider";

type Line = string | { title: string; description?: string } | null | undefined;

export interface ToastWriteEffects<V, D> {
  /** The reads stale once the write lands. */
  touches?: readonly QueryKey[] | ((vars: V) => readonly QueryKey[]);
  /** What the success toast says, or how to say it from the answer; nothing is toasted when absent. */
  said?: Line | ((answer: D, vars: V) => Line);
  /** The failure toast's title; the refusal's words follow it. */
  failed: string;
  /** How the refusal is worded under the title. */
  describe?: (err: unknown) => string;
  /** A refusal also leaves `touches` stale: the write may have moved what it was refused over. */
  touchesOnRefusal?: boolean;
}

export function useToastWrite<V = void, D = unknown>(mutationFn: (vars: V) => Promise<D>, { touches = [], said, failed, describe = formatApiError, touchesOnRefusal = false }: ToastWriteEffects<V, D>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const touch = (vars: V) => {
    for (const queryKey of typeof touches === "function" ? touches(vars) : touches) void qc.invalidateQueries({ queryKey });
  };
  return useMutation({
    mutationFn,
    onSuccess: (answer: D, vars: V) => {
      touch(vars);
      const line = typeof said === "function" ? said(answer, vars) : said;
      if (line) toast({ ...(typeof line === "string" ? { title: line } : line), tone: "success" });
    },
    onError: (err, vars) => {
      if (touchesOnRefusal) touch(vars);
      toast({ title: failed, description: describe(err), tone: "error" });
    },
  });
}
