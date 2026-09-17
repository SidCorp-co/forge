"use client";

// cm:guard every key here starts with `['conversations']`, which is the exact prefix `lib/ws/event-router.ts` invalidates on `conversation.message` and on `replayOnReconnect`. A key under any other prefix looks live on screen and silently never refreshes — the rule `features/sessions/hooks.ts` states for its own prefix, and the reason it states it (ISS-291).
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { conversationsApi, type OpenConversationArgs } from "./api";
import type {
  ConversationDetail,
  ConversationMembership,
  ConversationMode,
  ConversationProgressEntry,
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
      /** This browser's own id for the message, echoed on `conversation.accepted` (ISS-1078). */
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


/**
 * A key the socket writes and nothing fetches.
 */
// cm:guard read off the query CACHE through `useSyncExternalStore`, and not through `useQuery`. Two
// ways of doing this are both wrong and neither says so: a `useQuery` with `enabled: false` never
// observes a `setQueryData` at all — it returns its `initialData` for the life of the component, so
// the frames pile up in the cache and the screen shows none of them (watched failing, ISS-1078 step
// 16); and giving it a `queryFn` makes the key fetchable, so the invalidation the accepted frame
// itself schedules over the `["conversations", id]` prefix refetches this key and wipes the live turn
// off the screen mid-answer. With no observer registered there is no query to refetch, and the value
// is what the socket last wrote and nothing else.
// cm:guard `empty` must be the SAME reference on every call, which is why both callers below pass a
// module constant: a fresh `{}` per render makes the snapshot a new object each time and
// `useSyncExternalStore` re-renders forever.
function useSocketWrittenKey<T>(key: readonly unknown[], empty: T): T {
  const qc = useQueryClient();
  const flat = JSON.stringify(key);
  const subscribe = useCallback(
    (onChange: () => void) =>
      qc.getQueryCache().subscribe((event) => {
        if (JSON.stringify(event.query.queryKey) === flat) onChange();
      }),
    [qc, flat],
  );
  const read = useCallback(
    () => (qc.getQueryData(JSON.parse(flat) as unknown[]) as T | undefined) ?? empty,
    [qc, flat, empty],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Nothing has arrived yet — one reference, for the guard above. */
const NO_PROGRESS = null;
const NO_ACCEPTED: Record<string, { messageId: string; seq: number }> = {};
const NO_WITHDRAWN: Record<string, string> = {};

/**
 * The turn running in this room right now, as the socket's frames have it.
 */
// cm:guard there is no `queryFn` and there must not be one: nothing fetches a turn in flight — the
// value is WRITTEN by `lib/ws/event-router.ts` from `conversation.progress` and cleared on
// `conversation.settled`. A fetcher here would ask the server for a thing the server does not serve.
// The key sits under `["conversations", id]` so the prefix's invalidations still reach it (ISS-1078).
export function useConversationProgress(id: string | undefined) {
  return useSocketWrittenKey<ConversationProgressEntry | null>(
    ["conversations", id, "progress"],
    NO_PROGRESS,
  );
}

/**
 * Which of this tab's outbox messages the server has confirmed are rows.
 */
// cm:guard keyed by the CLIENT's token and not by seq: two tabs may each have a message in flight in
// the same room, and a tab that cleared its row on the other's acceptance would drop somebody else's
// message from its own screen. Written by the event router, read here (ISS-1078).
export function useAcceptedMessages(id: string | undefined) {
  return useSocketWrittenKey<Record<string, { messageId: string; seq: number }>>(
    ["conversations", id, "accepted"],
    NO_ACCEPTED,
  );
}

/**
 * The drafts the reply screen refused in this room, by the entry that replaced each.
 */
// cm:guard it is NOT cleared on `conversation.settled` and it is NOT durable, which is the whole
// point of it living here: the correction frame and the settle land within milliseconds of each
// other, so a marker drawn off the progress entry was on screen for 13 ms — measured in Chrome on a
// local walk, 2026-09-17. This key outlives the settle and dies with the page, so the withdrawal is
// shown to whoever was in the room and the stored transcript still holds only the sentence that went
// out. The price and the condition that ends it are on the `web-chat-reply` row in core's
// `messaging/doors.ts` (ISS-1078).
export function useWithdrawnDrafts(id: string | undefined) {
  return useSocketWrittenKey<Record<string, string>>(
    ["conversations", id, "withdrawn"],
    NO_WITHDRAWN,
  );
}
