// The issues feature's reads: one key factory and the queryOptions the hooks use. The shapes are the
// ones the WebSocket router invalidates by prefix (`['issues']`, `['issue', id]`,
// `['issues','standing']`, lib/ws/event-router.ts), so they stay as they are. An issue id may be the
// display key, scoped by its project (ISS-1160) — `issueKeySegment` folds both into one segment.
import type { IssueStandingScope } from "@forge/contracts/issue-standing";
import { queryOptions } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { issueKeySegment } from "@/lib/api/ref-bridge";
import { issuesApi, releaseBatchApi } from "./api";
import type { IssueLabel, IssueSearchOpts } from "./types";

export const issueKeys = {
  all: ["issues"] as const,
  search: (projectId: string | undefined, opts: IssueSearchOpts) => ["issues", "search", projectId, opts] as const,
  standingAll: ["issues", "standing"] as const,
  standing: (projectId: string | undefined, scope: IssueStandingScope) => ["issues", "standing", projectId ?? "", scope] as const,
  standingOf: (projectId: string | undefined, key: string | undefined) => ["issues", "standing", projectId ?? "", "one", key ?? ""] as const,
  one: (id: string | undefined, projectId?: string) => ["issue", issueKeySegment(id, projectId)] as const,
  cost: (id: string | undefined, projectId?: string) => [...issueKeys.one(id, projectId), "cost"] as const,
  deps: (id: string | undefined, projectId?: string) => [...issueKeys.one(id, projectId), "dependencies"] as const,
  attachments: (id: string | undefined, projectId?: string) => [...issueKeys.one(id, projectId), "attachments"] as const,
  criteria: (id: string | undefined, projectId?: string) => [...issueKeys.one(id, projectId), "criteria"] as const,
  patterns: (id: string | undefined, projectId?: string) => [...issueKeys.one(id, projectId), "patterns"] as const,
  checks: (id: string | undefined) => ["issue", id, "checks"] as const,
  judgedBuild: (id: string) => ["issue", id, "judged-build"] as const,
  comments: (id: string | undefined, projectId?: string) => ["comments", issueKeySegment(id, projectId)] as const,
  activities: (id: string | undefined, projectId?: string) => ["activities", issueKeySegment(id, projectId)] as const,
  members: (projectId: string | undefined) => ["project", projectId, "members"] as const,
  labels: (projectId: string | undefined) => ["project", projectId, "labels"] as const,
  roster: (projectId: string | undefined) => ["release-roster", projectId] as const,
};

export const issueQueries = {
  search: (projectId: string | undefined, opts: IssueSearchOpts) =>
    queryOptions({ ...readOf(issueKeys.search(projectId, opts), () => issuesApi.search(projectId as string, opts), 0), placeholderData: (prev) => prev }),
  standing: (projectId: string | undefined, scope: IssueStandingScope) =>
    ({ ...readOf(issueKeys.standing(projectId, scope), () => issuesApi.standing(projectId as string, scope), 10_000), enabled: !!projectId }),
  standingOf: (projectId: string | undefined, key: string | undefined) =>
    ({ ...readOf(issueKeys.standingOf(projectId, key), () => issuesApi.standingOf(projectId as string, key as string), 10_000), enabled: !!projectId && !!key }),
  cost: (id: string | undefined, enabled: boolean, projectId?: string) =>
    ({ ...readOf(issueKeys.cost(id, projectId), () => issuesApi.costSummary(id as string, projectId), 60_000), enabled: !!id && enabled }),
  deps: (id: string | undefined, enabled: boolean, projectId?: string) =>
    ({ ...readOf(issueKeys.deps(id, projectId), () => issuesApi.dependencies(id as string, projectId), 30_000), enabled: !!id && enabled }),
  members: (projectId: string | undefined) => readOf(issueKeys.members(projectId), () => issuesApi.members(projectId as string), 5 * 60_000),
  labels: (projectId: string | undefined) => readOf<IssueLabel[]>(issueKeys.labels(projectId), () => issuesApi.labels(projectId as string), 5 * 60_000),
  roster: (projectId: string | undefined) => readOf(issueKeys.roster(projectId), () => releaseBatchApi.roster(projectId as string), 0),
};
