"use client";

// web-v2 feature module: session (detail) — React Query hooks for the RUN
// thread. Every verb here rewrites or reads a run: its turns, its device, its
// cancel. The chat-only verbs — create, runner pin, rename, archive, delete and
// the interactive list — left with the chat surface at ISS-1004 step 5, and what
// replaced them is `features/conversations/hooks.ts`.
//
// Query-key contract (ISS-292): the detail row is keyed `['agent-session', id]`
// and turns `['agent-session', id, 'turns']` — exactly the keys the WS
// event-router invalidates on `agent-session.turn.appended/.edited/.truncated`
// (+ `agent-session.status/updated`). Pick any other prefix and the streaming
// caret + live turn updates silently no-op. See `lib/ws/event-router.ts`.

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

/** Session turns. Keyed `['agent-session', id, 'turns']` — WS-invalidated. */
export function useSessionTurns(id: string | undefined) {
  return useQuery({
    queryKey: ["agent-session", id, "turns"],
    queryFn: () => fetchAllTurns(id as string),
    enabled: !!id,
  });
}

// cm:guard follow `nextCursor` to the end — the server caps a page at 500 (`turns-helpers.ts`), and one page is not a session: run d089d6f3 has 1663 entries, so the single-page fetch rendered the first 500 and silently dropped the rest, closing the run report on "Now §E — the FAQ JSON-LD tokenizer." while the actual verdict sat in the tail.
const TURN_PAGE_CAP = 40;

export async function fetchAllTurns(id: string): Promise<TurnsResponse> {
  const turns: TurnRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < TURN_PAGE_CAP; page++) {
    const res = await sessionApi.getTurns(id, { after, limit: 500 });
    turns.push(...res.turns);
    if (!res.nextCursor) return { turns, nextCursor: null };
    after = res.nextCursor;
  }
  return { turns, nextCursor: null };
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

export function useCancelSession(id: string) {
  const invalidate = useInvalidateSession(id);
  const onError = useToastError();
  return useMutation({
    mutationFn: () => sessionApi.cancel(id),
    onSuccess: invalidate,
    onError,
  });
}

export function useRerunSession(id: string) {
  const onError = useToastError();
  return useMutation({ mutationFn: () => sessionApi.rerun(id), onError });
}

