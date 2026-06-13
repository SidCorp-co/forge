"use client";

// web-v2 feature module: session (detail) — React Query hooks.
//
// Query-key contract (ISS-292): the detail row is keyed `['agent-session', id]`
// and turns `['agent-session', id, 'turns']` — exactly the keys the WS
// event-router invalidates on `agent-session.turn.appended/.edited/.truncated`
// (+ `agent-session.status/updated`). Pick any other prefix and the streaming
// caret + live turn updates silently no-op. See `lib/ws/event-router.ts`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import type { SessionMetadata } from "@/features/sessions/types";
import {
  type CreateSessionOpts,
  type EditTurnOpts,
  type ForkOpts,
  type SendOpts,
  sessionApi,
} from "./api";

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
    queryFn: () => sessionApi.getTurns(id as string, { limit: 500 }),
    enabled: !!id,
  });
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

export function useSendMessage(id: string) {
  const invalidate = useInvalidateSession(id);
  const onError = useToastError();
  return useMutation({
    mutationFn: (opts: SendOpts) => sessionApi.send(opts),
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

/** Chat bootstrap: resume the latest interactive `agent` session, else create one. */
export function useCreateSession() {
  const qc = useQueryClient();
  const onError = useToastError();
  return useMutation({
    mutationFn: (opts: CreateSessionOpts) => sessionApi.create(opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-sessions"] }),
    onError,
  });
}

// ISS-465 — conversation management mutations. Each invalidates the
// ['agent-sessions'] family (the chat history list query is keyed
// ['agent-sessions','chat',projectId], so the prefix matches) AND the
// ['agent-session', id] detail family.

/** Rename a conversation via PATCH title. */
export function useRenameSession() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const onError = useToastError();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => sessionApi.rename(id, title),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      qc.invalidateQueries({ queryKey: ["agent-session", vars.id] });
      toast({ title: "Renamed", tone: "success" });
    },
    onError,
  });
}

/** Soft-archive / unarchive a conversation via PATCH metadata. */
export function useArchiveSession() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const onError = useToastError();
  return useMutation({
    mutationFn: ({
      id,
      archived,
      metadata,
    }: {
      id: string;
      archived: boolean;
      metadata: SessionMetadata | null;
    }) => sessionApi.setArchived(id, archived, metadata),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      qc.invalidateQueries({ queryKey: ["agent-session", vars.id] });
      toast({ title: vars.archived ? "Archived" : "Restored", tone: "success" });
    },
    onError,
  });
}

/** Hard-delete a conversation (owner-or-admin gated server-side). */
export function useDeleteSession() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const onError = useToastError();
  return useMutation({
    mutationFn: (id: string) => sessionApi.remove(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      qc.invalidateQueries({ queryKey: ["agent-session", id] });
      toast({ title: "Deleted", tone: "success" });
    },
    onError,
  });
}
