"use client";

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
export function useConversationsAcrossProjects(projectIds: string[], archived = false) {
  const results = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["conversations", "list", projectId, archived ? "archived" : "live"],
      queryFn: () => conversationsApi.list(projectId, 50, archived),
    })),
  });
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
const AGENT_TURN_POLL_MS = 4000;

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ["conversations", id],
    queryFn: () => conversationsApi.detail(id as string),
    enabled: !!id,
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
export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      content,
      mode,
      clientToken,
      attachmentIds,
    }: {
      conversationId: string;
      content: string;
      /** Sent on the FIRST message of a room and never again; the server refuses it after that. */
      mode?: ConversationMode | undefined;
      /** This browser's own id for the message, echoed on `conversation.accepted` (ISS-1078). */
      clientToken?: string | undefined;
      /** Files already uploaded to this room, staged with this message (ISS-1146). */
      attachmentIds?: string[] | undefined;
    }) => conversationsApi.send(conversationId, content, mode, clientToken, attachmentIds),
    onSuccess: async (result) => {
      await qc.cancelQueries({ queryKey: ["conversations", result.conversationId] });
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

/**
 * Put one staged file in this room, and say which stored file it became.
 *
 * Not a react-query cache write: nothing reads an upload on its own, and what
 * the room shows is the message the ids are then sent with.
 */
export function useUploadAttachment() {
  return useMutation({
    mutationFn: ({ conversationId, file }: { conversationId: string; file: File }) =>
      conversationsApi.upload(conversationId, file),
  });
}

/**
 * End the turn this room is answering. A room running nothing is refused by
 * name, and the message says so rather than a silent no-op.
 */
export function useStopConversation() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (conversationId: string) => conversationsApi.stop(conversationId),
    onError: (err) =>
      toast({ title: "Couldn't stop this answer", description: formatApiError(err), tone: "error" }),
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
export function useConversationProgress(id: string | undefined) {
  return useSocketWrittenKey<ConversationProgressEntry | null>(
    ["conversations", id, "progress"],
    NO_PROGRESS,
  );
}

/**
 * Which of this tab's outbox messages the server has confirmed are rows.
 */
export function useAcceptedMessages(id: string | undefined) {
  return useSocketWrittenKey<Record<string, { messageId: string; seq: number }>>(
    ["conversations", id, "accepted"],
    NO_ACCEPTED,
  );
}

/**
 * The drafts the reply screen refused in this room, by the entry that replaced each.
 */
export function useWithdrawnDrafts(id: string | undefined) {
  return useSocketWrittenKey<Record<string, string>>(
    ["conversations", id, "withdrawn"],
    NO_WITHDRAWN,
  );
}
