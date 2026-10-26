import { queryOptions } from "@tanstack/react-query";
import { isUuid } from "@/lib/api/ref-bridge";
import { questionsApi } from "./api";

/**
 * Every query key questions read under. A question's ask, answer, void and expiry reach the project
 * room as `question.changed` (`lib/ws/event-router.ts`), which refetches `["questions"]`; the polls
 * below stay as the fallback for a dropped socket.
 */
export const questionKeys = {
  all: ["questions"] as const,
  issue: (issueId: string, projectId?: string) =>
    issueId && !isUuid(issueId) ? (["questions", { issue: issueId, project: projectId ?? null }] as const) : (["questions", issueId] as const),
  project: (projectId: string) => ["questions", "project", projectId] as const,
  /** Under the project's key, so answering from either surface refreshes the other. */
  gate: (projectId: string, documentId: string) => ["questions", "project", projectId, "gate", documentId] as const,
};

const POLL_MS = 30_000;

export const questionQueries = {
  /** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
  issue: (issueId: string, projectId?: string) =>
    queryOptions({
      queryKey: questionKeys.issue(issueId, projectId),
      queryFn: () => questionsApi.listForIssue(issueId, projectId),
      enabled: Boolean(issueId),
      refetchInterval: (query) => ((query.state.data?.questions.length ?? 0) > 0 ? POLL_MS : false),
    }),
};
