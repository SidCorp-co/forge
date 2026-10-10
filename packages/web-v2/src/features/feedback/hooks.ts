"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { feedbackForecastKey } from "@/features/forecast";
import { recordingsKey, reproduceApi } from "@/features/previews";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { feedbackApi } from "./api";
import type { CreateFeedbackRequest, FeedbackAction, FeedbackMessageAudience, PromoteAgentReportRequest } from "./types";

/** While a reproduce recording is still taking batches the list is read again on this clock. */
const RECORDING_POLL_MS = 10_000;

/** Every query key the feedback feature reads under. */
export const feedbackKeys = {
  list: (projectId: string | undefined) => ["feedback", projectId] as const,
  /** Every open item of the project: the prefix of each item read. */
  items: (projectId: string | undefined) => ["feedback-item", projectId] as const,
  item: (projectId: string | undefined, key: string | undefined) => ["feedback-item", projectId, key] as const,
};

/** The reproduce recordings of one item, newest first: members only, core refusing anyone else as RECORDING_FORBIDDEN. */
export function useItemRecordings(projectId: string, fbKey: string) {
  return useQuery({
    queryKey: recordingsKey(projectId, fbKey),
    queryFn: () => reproduceApi.recordings(projectId, fbKey),
    refetchInterval: (query) => (query.state.data?.some((r) => r.state === "recording") ? RECORDING_POLL_MS : false),
  });
}

export const useFeedbackList = (projectId: string | undefined) => useQuery(readOf(feedbackKeys.list(projectId), () => feedbackApi.list(projectId as string)));

export const useFeedbackItem = (projectId: string | undefined, key: string | undefined) =>
  useQuery(readOf(feedbackKeys.item(projectId, key), () => feedbackApi.get(projectId as string, key as string)));

/** The routes and tools the project serves, read only while a picker is on "API route or tool". */
export const useFeedbackEndpoints = (projectId: string, enabled: boolean) =>
  useQuery({ ...readOf(["feedback-endpoints", projectId], () => feedbackApi.endpoints(projectId), 60_000), enabled: Boolean(projectId) && enabled });

export const useFeedbackChoices = (projectId: string, type: "requirement" | "workflow" | "release" | null) =>
  useQuery(readOf(["feedback-choices", projectId, type], () => feedbackApi.choices(projectId, type as "requirement" | "workflow" | "release")));

/** What every write to feedback changes: the list, the items, the suggestions about them and their forecast. */
const touched = (projectId: string) => [feedbackKeys.list(projectId), feedbackKeys.items(projectId), ["suggestions", projectId], feedbackForecastKey(projectId)];

export const useCreateFeedback = (projectId: string) => useWrite((body: CreateFeedbackRequest) => feedbackApi.create(projectId, body), { touches: touched(projectId) });

/** Attach files to an item: to the one a page shows, or to the key a filing was just answered with. */
export const useAttachFeedback = (projectId: string) =>
  useWrite(({ key, files }: { key: string; files: readonly File[] }) => feedbackApi.attach(projectId, key, files), {
    shows: ({ key }) => feedbackKeys.item(projectId, key),
    touches: touched(projectId),
  });

export const usePromoteFeedback = (projectId: string) =>
  useWrite((body: PromoteAgentReportRequest) => feedbackApi.promote(projectId, body), { touches: [...touched(projectId), ["agent-reports", projectId]] });

/** A write to one item whose answer is the item as it reads next. */
const useItemWrite = <V,>(projectId: string, key: string, write: (vars: V) => ReturnType<typeof feedbackApi.get>) =>
  useWrite(write, { shows: feedbackKeys.item(projectId, key), touches: touched(projectId) });

/** Triage, retarget, decline, verify, reopen or delete reporter data. */
export const useFeedbackAction = (projectId: string, key: string) => useItemWrite(projectId, key, (a: FeedbackAction) => feedbackApi.act(projectId, key, a));

/** What a message to reporters would say and to whom, read before it is sent. */
export const usePreviewMessage = (projectId: string, key: string) =>
  useMutation({
    mutationFn: (body: { audience: Exclude<FeedbackMessageAudience, "internal">; text: string }) => feedbackApi.previewMessage(projectId, key, body),
  });

/** A message to reporters, or an internal note; the answer is the item with its thread. */
export const useSendMessage = (projectId: string, key: string) =>
  useItemWrite(projectId, key, (body: { audience: FeedbackMessageAudience; text: string; relayed?: boolean }) => feedbackApi.sendMessage(projectId, key, body));

/** Tells a shipped item's reporters now that it shipped; the answer is the item reading them told. */
export const useTellShipped = (projectId: string, key: string) => useItemWrite(projectId, key, () => feedbackApi.tellShipped(projectId, key));
