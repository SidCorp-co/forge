"use client";

// cm:guard every key here starts with `['conversations']`, which is the exact prefix `lib/ws/event-router.ts` invalidates on `conversation.message` and on `replayOnReconnect`. A key under any other prefix looks live on screen and silently never refreshes — the rule `features/sessions/hooks.ts` states for its own prefix, and the reason it states it (ISS-291).
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { conversationsApi, type OpenConversationArgs } from "./api";
import type {
  ConversationDetail,
  ConversationMembership,
  ConversationMode,
  ConversationProgress,
  ConversationRow,
} from "./types";

/** A room in a list that spans projects — the project is the query it came from, not a column. */
export interface ListedConversation extends ConversationRow {
  projectId: string;
}

// cm:guard the archived side is a SEPARATE cache key and not a filter over one list: the two are
// two reads of two disjoint sets, and sharing a key would serve the archived rooms to the default
// list for as long as the refetch took — which is the moment somebody has just archived one and is
// looking to see it go (ISS-1028).
export function useConversations(projectId: string | undefined, archived = false) {
  return useQuery({
    queryKey: ["conversations", "list", projectId, archived ? "archived" : "live"],
    queryFn: () => conversationsApi.list(projectId as string, 50, archived),
    enabled: !!projectId,
  });
}

/**
 * Every project's rooms, in one list, newest first — the live set, or the archived one.
 */
// cm:guard the fan-out is N reads and not one, because `/api/conversations` takes a project and the store has no cross-project list: a room's readability is a per-project role question, so a single endpoint would have to authorize every row before it knew what a page held — which is the unbounded read `store.ts:listConversationsInProject` already prices, once per project rather than once for the fleet. The set is the caller's own org projects and each read is cached by project.
export function useConversationsAcrossProjects(projectIds: string[], archived = false) {
  const results = useQueries({
    // cm:guard the key and the request are the SAME ones `useConversations` builds for whichever
    // side is asked for, down to the trailing segment and the page size: the dock's per-project list
    // and this screen read the same rooms, and two keys over one read would fetch every project
    // twice and leave one copy stale after an archive. That is why the segment is the same
    // `archived ? "archived" : "live"` expression rather than a second vocabulary for the same two
    // sets — a screen that spelled its archived key differently would share the live set with the
    // dock and silently not share the archived one (ISS-1040).
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", "list", projectId, archived ? "archived" : "live"],
      queryFn: () => conversationsApi.list(projectId, 50, archived),
    })),
  });
  // cm:guard ONE row per room, not one per project it is about, on BOTH sides: a room is listed by every project in its scope, and since ISS-1011 a room can be about more than one — so the same room came back from two of these reads and the list printed it twice, same title, same time, differing only by the project line under it. Two rows that open the same room read as two rooms. The kept row is the first by the sorted project order, which is stable across reads, and a room's projects are named inside the room rather than by repeating it in the list. An archived room is about exactly the same projects it was about before it was filed away, so the archived set needs this every bit as much as the live one (ISS-1040).
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

/**
 * How often a room with a live Agent turn in it re-reads itself.
 */
// cm:guard polling and NOT a socket, and the reason is what the two can carry: the delivery event
// tells a tab a message arrived, and what a person watching an Agent turn is waiting on is a STATE —
// a box picking the turn up, the session starting — which no row change publishes. It stops the
// moment nothing is live, so a room in Assistant mode polls not at all (ISS-1039, plan consult F3).
const AGENT_TURN_POLL_MS = 4000;

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversations", id],
    queryFn: () => conversationsApi.detail(id as string),
    enabled: !!id,
    // cm:guard the predicate reads the SERVED state and never a local guess: `dispatched` and
    // `running` are the two that can still move on their own, and a room holding neither is read
    // exactly as often as it was before this change.
    refetchInterval: (query) => {
      const live = query.state.data?.agentTurns?.some(
        (t) => t.state === "dispatched" || t.state === "running",
      );
      return live ? AGENT_TURN_POLL_MS : false;
    },
  });
}

/**
 * Whether a NEW room in this project could be opened in Agent mode.
 */
// cm:guard asked only while there is no room to ask about, which is the draft: once a room exists its
// own `agentMode` is the answer, and two probes for one question is how a composer comes to disagree
// with the room it is sitting in (ISS-1039).
/**
 * The turn being written in this room right now, as the socket left it.
 */
// cm:guard the key is a slot the event router WRITES and not a read anybody makes, which is what
// keeps a progress frame from costing a refetch of the whole room (ISS-1030's cost).
// cm:guard it is NOT under `['conversations', id]`, and this file's own opening rule is what makes
// that worth saying: react-query invalidates by PREFIX, so under that key the `conversation.message`
// case would refetch this slot to null in the same tick a frame wrote it — the live turn would
// vanish on the delivery event rather than on the settle. Nothing invalidates this prefix (ISS-1078).
export function useConversationProgress(id: string | undefined) {
  return useQuery<ConversationProgress | null>({
    queryKey: ["conversation-progress", id],
    enabled: !!id,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => null,
  });
}

/**
 * The messages this tab's own sends have been told are durable.
 */
// cm:guard the same slot-not-a-read rule and the same prefix reasoning as the progress key above:
// under `['conversations', id]` the delivery event would clear which tokens were accepted, and every
// held row would go back to reading "Sending…" after the server had already filed it.
// cm:guard it exists so an outbox row can be held until its durable copy is actually in the room:
// acceptance carries ids, and an already open room's cache predates the send, so dropping the row on
// acceptance would make the question vanish until a later read brought it back (plan consult F4).
export function useAcceptedMessages(id: string | undefined) {
  return useQuery<Array<{ clientToken: string | null; messageId: string }>>({
    queryKey: ["conversation-accepted", id],
    enabled: !!id,
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => [],
  });
}

export function useDraftAgentMode(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["conversations", "agent-mode", projectId],
    queryFn: () => conversationsApi.agentMode(projectId as string),
    enabled: !!projectId && enabled,
    staleTime: 30_000,
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
    mutationFn: ({
      conversationId,
      content,
      mode,
      clientToken,
    }: {
      conversationId: string;
      content: string;
      /** Sent on the FIRST message of a room and never again; the server refuses it after that. */
      mode?: ConversationMode | undefined;
      /** This tab's own id for the copy it is already showing; echoed back on `conversation.accepted`. */
      clientToken?: string | undefined;
    }) => conversationsApi.send(conversationId, content, mode, clientToken),
    onSuccess: async (result) => {
      await qc.cancelQueries({ queryKey: ["conversations", result.conversationId] });
      // cm:guard the room's own `mode` and its `agentTurns` are written with the messages, because
      // the first send is what settles the first and starts the second: a room that kept a cached
      // `mode: null` would go on offering the pick after it had been made, and one that kept an
      // empty `agentTurns` would show a dispatched Agent turn as a thread with nothing in it until
      // the next poll (ISS-1039).
      qc.setQueryData<ConversationDetail>(["conversations", result.conversationId], (prev) =>
        prev
          ? {
              ...prev,
              mode: result.mode,
              messages: result.messages,
              windows: result.windows,
              agentTurns: result.agentTurns,
            }
          : prev,
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

// cm:guard the invalidate is the whole `["conversations"]` prefix rather than the one list the row
// came from: archiving moves a room from one list to the other, so refreshing only the list it left
// leaves it missing from both until something else happens to refetch.
export function useArchiveConversation() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: { id: string; archived: boolean }) =>
      conversationsApi.setArchived(args.id, args.archived),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: (err, args) =>
      toast({
        title: args.archived ? "Couldn't archive" : "Couldn't unarchive",
        description: formatApiError(err),
        tone: "error",
      }),
  });
}
