"use client";


import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import type { TurnRow, TurnsResponse } from "./types";
import { type EditTurnOpts, type ForkOpts, type SendOpts, sessionApi } from "./api";

/** Session detail row. Keyed `['agent-session', id]` — WS-invalidated. */
export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: ["agent-session", id],
    queryFn: () => sessionApi.detail(id as string),
    enabled: !!id,
  });
}

/**
 * Session turns, the first `pages` pages of `TURN_PAGE_SIZE`. Keyed
 * `['agent-session', id, 'turns', pages]` — the WS prefix invalidation still reaches it. A non-null
 * `nextCursor` means later turns exist and were not loaded; raise `pages` to load them.
 */
export function useSessionTurns(id: string | undefined, pages: number = TURN_PAGE_CAP) {
  return useQuery({
    queryKey: ["agent-session", id, "turns", pages],
    queryFn: () => fetchAllTurns(id as string, pages),
    enabled: !!id,
    // Keeps the loaded turns on screen while more pages load, never across sessions.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
  });
}

/** The session's turns, plus the act that loads the next `TURN_PAGE_CAP` pages past a cap. */
export function useSessionTurnPages(id: string) {
  const [loaded, setLoaded] = useState({ id, pages: TURN_PAGE_CAP });
  const pages = loaded.id === id ? loaded.pages : TURN_PAGE_CAP;
  const turnsQ = useSessionTurns(id, pages);
  return { turnsQ, loadMoreTurns: () => setLoaded({ id, pages: pages + TURN_PAGE_CAP }) };
}

export const TURN_PAGE_SIZE = 500;
export const TURN_PAGE_CAP = 40;

export async function fetchAllTurns(id: string, pages: number = TURN_PAGE_CAP): Promise<TurnsResponse> {
  const turns: TurnRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const res = await sessionApi.getTurns(id, { after, limit: TURN_PAGE_SIZE });
    turns.push(...res.turns);
    if (!res.nextCursor) return { turns, nextCursor: null };
    after = res.nextCursor;
  }
  return { turns, nextCursor: after ?? null };
}

/** Invalidate the whole `['agent-session', id]` family after a mutation. */
function useInvalidateSession(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["agent-session", id] });
    qc.invalidateQueries({ queryKey: ["agent-sessions"] });
  };
}

function useToastError() {
  const { toast } = useToast();
  return (err: unknown) =>
    toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
}

/**
 * Send a chat turn, optionally with staged files (ISS-499). Files are uploaded
 * sequentially to the turn's session FIRST (multipart), then their ids ride the
 * `send` as `attachmentIds`. A per-file upload failure toasts but does not abort
 * the send — the message still goes with whatever uploaded (mirrors the comment
 * attachment flow). `opts.sessionId` is the resolved session id.
 */
export function useSendMessage(id: string) {
  const invalidate = useInvalidateSession(id);
  const onError = useToastError();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ files, ...opts }: SendOpts & { files?: File[] }) => {
      const ids: string[] = [...(opts.attachmentIds ?? [])];
      for (const file of files ?? []) {
        try {
          const att = await sessionApi.uploadAttachment(opts.sessionId, file);
          ids.push(att.id);
        } catch (err) {
          toast({
            title: "An attachment failed to upload",
            description: `${file.name}: ${formatApiError(err)}`,
            tone: "error",
          });
        }
      }
      return sessionApi.send({ ...opts, attachmentIds: ids.length ? ids : undefined });
    },
    onSuccess: invalidate,
    onError,
  });
}

export function useRegenerateTurn(id: string) {
  const invalidate = useInvalidateSession(id);
  const onError = useToastError();
  return useMutation({
    mutationFn: (turnId: string) => sessionApi.regenerate(id, turnId),
    onSuccess: invalidate,
    onError,
  });
}

export function useEditTurn(id: string) {
  const invalidate = useInvalidateSession(id);
  const onError = useToastError();
  return useMutation({
    mutationFn: ({ turnId, ...opts }: EditTurnOpts & { turnId: string }) =>
      sessionApi.editTurn(id, turnId, opts),
    onSuccess: invalidate,
    onError,
  });
}

export function useForkSession(id: string) {
  const { toast } = useToast();
  const onError = useToastError();
  return useMutation({
    mutationFn: (opts: ForkOpts) => sessionApi.fork(id, opts),
    onSuccess: () => toast({ title: "Session forked", tone: "success" }),
    onError,
  });
}

