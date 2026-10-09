"use client";

import { useIssueForecast } from "@/features/forecast/hooks";
import { useMockups } from "@/features/mockups/hooks";
import { useIssueQuestions } from "@/features/questions/hooks";
import { isUuid, useBridgedRef } from "@/lib/api/ref-bridge";
import { useCriteria } from "../criteria";
import { issueRekey } from "../derive";
import { useActivity, useAttachments, useComments, useIssue } from "../detail-hooks";
import {
  useIssueCost,
  useIssueDeps,
  useIssueStandingOf,
  useProjectMembers,
  useProjectModules,
  useReleaseRoster,
} from "../hooks";
import { useIssuePark } from "../park";
import { useIssuePatterns } from "../patterns-api";

/**
 * Every read the issue page makes, sent with the page. `id` off the URL is the display key as often
 * as the row uuid (ISS-1160) and `projectId` may still be the project's slug: core takes both, so
 * nothing waits on the projects list or on the issue to learn a uuid. Once the issue answers, its own
 * reads move to its uuid with what they already read handed over (`useBridgedRef`), and the screen's
 * children, which key by the uuid, find them there.
 */
export function useIssueReads(id: string, projectId: string) {
  const issueQ = useIssue(id, projectId);
  const mockupTarget = { type: "issue" as const, key: issueQ.data?.displayId ?? id };
  const mockupsQ = useMockups(projectId, mockupTarget);
  const bridgedRef = useBridgedRef(isUuid(id) ? undefined : id, issueQ.data?.id, (key, uuid) =>
    issueRekey(key, projectId, uuid),
  );
  const canonicalId = isUuid(id) ? id : bridgedRef;
  const displayKey = issueQ.data?.displayId ?? (isUuid(id) ? undefined : id);
  useActivity(canonicalId, projectId);
  useAttachments(canonicalId, projectId);
  useIssueQuestions(canonicalId ?? "", projectId);
  useIssueForecast(projectId, displayKey);
  useProjectMembers(projectId);
  useProjectModules(projectId);
  useReleaseRoster(projectId);
  useIssuePatterns(canonicalId, projectId);
  const issue = issueQ.data;
  return {
    issueQ,
    mockupTarget,
    mockupsQ,
    canonicalId,
    /** The issue answered but the page has not yet moved its reads to the uuids; its children key by them, so they wait a frame. */
    switching: !!issue && (canonicalId !== issue.id || (projectId !== issue.projectId && !isUuid(projectId))),
    commentsQ: useComments(canonicalId, projectId),
    depsQ: useIssueDeps(canonicalId, true, projectId),
    costQ: useIssueCost(canonicalId, true, projectId),
    standingQ: useIssueStandingOf(projectId, displayKey),
    /** ISS-1310 — one reading of what a person owes this issue, for the banner, the status control and the decision panel. */
    park: useIssuePark(canonicalId, issueQ.data?.status, projectId),
    criteriaQ: useCriteria(canonicalId, projectId),
  };
}
