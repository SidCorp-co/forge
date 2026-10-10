// The previews feature's reads: one key factory and its queryOptions. `['preview', issueId]` is the
// key `lib/ws/event-router.ts` invalidates on `preview.changed`.
import type { PreviewRecord } from "@forge/contracts/preview";
import { queryOptions } from "@tanstack/react-query";
import { issueKeySegment } from "@/lib/api/ref-bridge";
import { type IssueLane, previewsApi } from "./api";
import { ideaApi } from "./idea-api";

/** A preview still starting is read again on a short clock, so a missed frame cannot leave it starting for good. */
export const STARTING_POLL_MS = 3000;

export const previewKeys = {
  issue: (issueId: string | undefined) => ["preview", issueId] as const,
  issueRead: (issueId: string | undefined, projectId?: string) => ["preview", issueKeySegment(issueId, projectId)] as const,
  lane: (issueId: string) => ["preview", issueId, "lane"] as const,
  ticket: (previewId: string, round: number) => ["previews", "ticket", previewId, round] as const,
  idea: (id: string) => ["idea-preview", id] as const,
  recordings: (projectId: string, fb: string) => ["recordings", projectId, fb] as const,
};

export const previewQueries = {
  /** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
  issue: (issueId: string | undefined, projectId?: string) =>
    queryOptions({
      queryKey: previewKeys.issueRead(issueId, projectId),
      queryFn: () => previewsApi.ofIssue(issueId as string, projectId),
      enabled: !!issueId,
      refetchInterval: (q) => (q.state.data?.state === "starting" ? STARTING_POLL_MS : false),
    }),
  lane: (issueId: string, enabled: boolean) =>
    queryOptions<IssueLane>({ queryKey: previewKeys.lane(issueId), queryFn: () => previewsApi.lane(issueId), enabled }),
  /** A ticket is single-use: one per entry, read once and never cached past it. */
  ticket: (previewId: string, round: number) =>
    queryOptions({
      queryKey: previewKeys.ticket(previewId, round),
      queryFn: () => previewsApi.ticketUrl(previewId),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
      retry: false,
    }),
  idea: (initial: PreviewRecord) =>
    queryOptions({
      queryKey: previewKeys.idea(initial.id),
      queryFn: () => ideaApi.get(initial.id),
      initialData: initial,
      refetchInterval: (q) => (q.state.data?.state === "starting" ? STARTING_POLL_MS : false),
    }),
};
