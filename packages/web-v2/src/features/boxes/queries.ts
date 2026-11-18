// The boxes feature's reads. `['boxes', projectId]` and `['box', boxId]` are the keys
// `lib/ws/event-router.ts` invalidates on `box.changed`.
import { queryOptions } from "@tanstack/react-query";
import { boxesApi } from "./api";

export const boxKeys = {
  project: (projectId: string) => ["boxes", projectId] as const,
  one: (boxId: string) => ["box", boxId, "record"] as const,
  acts: (boxId: string) => ["box", boxId, "acts"] as const,
  spans: (boxId: string) => ["box", boxId, "spans"] as const,
  ticket: (boxId: string, channel: "view" | "input", round: string) => ["box-ticket", boxId, channel, round] as const,
  issueLabel: (issueId: string) => ["box-issue", issueId] as const,
};

export const boxQueries = {
  project: (projectId: string) => queryOptions({ queryKey: boxKeys.project(projectId), queryFn: () => boxesApi.ofProject(projectId) }),
  one: (boxId: string) => queryOptions({ queryKey: boxKeys.one(boxId), queryFn: () => boxesApi.one(boxId), retry: false }),
  acts: (boxId: string) => queryOptions({ queryKey: boxKeys.acts(boxId), queryFn: () => boxesApi.acts(boxId) }),
  spans: (boxId: string) => queryOptions({ queryKey: boxKeys.spans(boxId), queryFn: () => boxesApi.spans(boxId) }),
  /** A ticket is single-use: one per entry, read once and never cached past it. */
  ticket: (boxId: string, channel: "view" | "input", round: string) =>
    queryOptions({
      queryKey: boxKeys.ticket(boxId, channel, round),
      queryFn: () => boxesApi.ticket(boxId, channel),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 0,
      retry: false,
    }),
  issueLabel: (issueId: string) =>
    queryOptions({ queryKey: boxKeys.issueLabel(issueId), queryFn: () => boxesApi.issueLabel(issueId), staleTime: 5 * 60_000 }),
};
