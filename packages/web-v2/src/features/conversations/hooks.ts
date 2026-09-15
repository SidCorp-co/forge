"use client";

// cm:guard every key here starts with `['conversations']`, which is the exact prefix `lib/ws/event-router.ts` invalidates on `conversation.message` and on `replayOnReconnect`. A key under any other prefix looks live on screen and silently never refreshes — the rule `features/sessions/hooks.ts` states for its own prefix, and the reason it states it (ISS-291).
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { conversationsApi, type OpenConversationArgs } from "./api";
import type { ConversationDetail, ConversationMembership, ConversationRow } from "./types";

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
  // cm:guard ONE row per room, not one per project it is about: a room is listed by every project in its scope, and since ISS-1011 a room can be about more than one — so the same room came back from two of these reads and the list printed it twice, same title, same time, differing only by the project line under it. Two rows that open the same room read as two rooms. The kept row is the first by the sorted project order, which is stable across reads, and a room's projects are named inside the room rather than by repeating it in the list.
  const rows: ListedConversation[] = [];
  const listed = new Set<string>();
  for (const [i, r] of results.entries()) {
    const projectId = projectIds[i];
    if (!projectId || !r.data) continue;
    for (const row of r.data.items) {
      if (listed.has(row.id)) continue;
      listed.add(row.id);
      rows.push({ ...row, projectId });
    }
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
    mutationFn: (args: OpenConversationArgs) => conversationsApi.open(args),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/**
 * Who this caller could still put in this room.
 */
// cm:guard it is NOT fetched with the room, because it is a directory read the size of an org and the room's own read is on the path a person waits behind to see a message. It is asked for when a dialogue opens, which is the only moment anybody needs it.
export function useConversationCandidates(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["conversations", id, "candidates"],
    queryFn: () => conversationsApi.candidates(id as string),
    enabled: !!id && enabled,
  });
}

/** The same question for a room that does not exist yet. */
export function useProjectCandidates(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["conversations", "candidates", projectId],
    queryFn: () => conversationsApi.candidatesForProject(projectId as string),
    enabled: !!projectId && enabled,
  });
}

/**
 * Put what a membership change answered with straight into the room's cache.
 */
// cm:guard the answer is WRITTEN and not invalidated, for the reason `useSendMessage` gives for the same move: the call already carries the room's whole membership, its shape and its derived scope, so a refetch would throw all three away and render the room as it was for as long as the second request took — which is the moment a person is looking hardest at what they just changed.
function useMembershipWrite<Args>(
  run: (args: Args) => Promise<ConversationMembership>,
  conversationId: string | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async (membership) => {
      if (!conversationId) return;
      await qc.cancelQueries({ queryKey: ["conversations", conversationId] });
      qc.setQueryData<ConversationDetail>(["conversations", conversationId], (prev) =>
        prev ? { ...prev, ...membership } : prev,
      );
      qc.invalidateQueries({ queryKey: ["conversations", conversationId, "candidates"] });
      qc.invalidateQueries({ queryKey: ["conversations", "list"] });
    },
  });
}

export function useAddPerson(conversationId: string | undefined) {
  return useMembershipWrite(
    (args: { userId: string }) =>
      conversationsApi.addPerson(conversationId as string, args.userId),
    conversationId,
  );
}

export function useAddHandle(conversationId: string | undefined) {
  return useMembershipWrite(
    (args: { userId: string | null; projectId: string }) =>
      conversationsApi.addHandle(conversationId as string, args.userId, args.projectId),
    conversationId,
  );
}

export function useRemoveParticipant(conversationId: string | undefined) {
  return useMembershipWrite(
    (args: { participantId: string }) =>
      conversationsApi.removeParticipant(conversationId as string, args.participantId),
    conversationId,
  );
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
