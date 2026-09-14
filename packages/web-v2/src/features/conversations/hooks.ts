"use client";

// cm:guard every key here starts with `['conversations']`, which is the exact prefix `lib/ws/event-router.ts` invalidates on `conversation.message` and on `replayOnReconnect`. A key under any other prefix looks live on screen and silently never refreshes — the rule `features/sessions/hooks.ts` states for its own prefix, and the reason it states it (ISS-291).
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { conversationsApi } from "./api";
import type { ConversationDetail, ConversationRow } from "./types";

/** A room in a list that spans projects — the project is the query it came from, not a column. */
export interface ListedConversation extends ConversationRow {
  projectId: string;
}

export function useConversations(projectId: string | undefined) {
  return useQuery({
    queryKey: ["conversations", "list", projectId],
    queryFn: () => conversationsApi.list(projectId as string),
    enabled: !!projectId,
  });
}

/**
 * Every project's rooms, in one list, newest first.
 */
// cm:guard the fan-out is N reads and not one, because `/api/conversations` takes a project and the store has no cross-project list: a room's readability is a per-project role question, so a single endpoint would have to authorize every row before it knew what a page held — which is the unbounded read `store.ts:listConversationsInProject` already prices, once per project rather than once for the fleet. The set is the caller's own org projects and each read is cached by project.
export function useConversationsAcrossProjects(projectIds: string[]) {
  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", "list", projectId],
      queryFn: () => conversationsApi.list(projectId),
    })),
  });
  const rows: ListedConversation[] = [];
  for (const [i, r] of results.entries()) {
    const projectId = projectIds[i];
    if (!projectId || !r.data) continue;
    for (const row of r.data.items) rows.push({ ...row, projectId });
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return {
    rows,
    isLoading: results.some((r) => r.isLoading),
    error: results.find((r) => r.isError)?.error ?? null,
    refetch: () => {
      for (const r of results) void r.refetch();
    },
  };
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversations", id],
    queryFn: () => conversationsApi.detail(id as string),
    enabled: !!id,
  });
}

export function useOpenConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; title?: string | null }) =>
      conversationsApi.open(args.projectId, args.title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/**
 * Say something, and put what came back where the thread reads it.
 */
// cm:guard the room is named PER CALL and never closed over: a draft opens its room and sends in one chain, so a mutation built from the render's `conversationId` still holds `undefined` when the send runs and posts to `/conversations/undefined/messages` — the first message of every new conversation, failing, leaving the room empty behind it (ISS-1004 step 5, review F3).
// cm:guard the response is WRITTEN into the detail cache, keyed by the id the SERVER answered with, and the room's own read is CANCELLED first: this one request carries the question, the answer and the window's decision, so an invalidate-and-refetch would throw all three away for a second round trip — and a read already in flight when the send landed would otherwise resolve afterwards and put the room back as it was before the answer. A client holding no cached room is not written to and does not need to be: its own `useConversation` is fetching.
export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, content }: { conversationId: string; content: string }) =>
      conversationsApi.send(conversationId, content),
    onSuccess: async (result) => {
      await qc.cancelQueries({ queryKey: ["conversations", result.conversationId] });
      qc.setQueryData<ConversationDetail>(["conversations", result.conversationId], (prev) =>
        prev ? { ...prev, messages: result.messages, windows: result.windows } : prev,
      );
      qc.invalidateQueries({ queryKey: ["conversations", "list"] });
    },
  });
}

export function useRenameConversation() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: { id: string; title: string | null }) =>
      conversationsApi.rename(args.id, args.title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: (err) =>
      toast({ title: "Couldn't rename", description: formatApiError(err), tone: "error" }),
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => conversationsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: (err) =>
      toast({ title: "Couldn't delete", description: formatApiError(err), tone: "error" }),
  });
}
