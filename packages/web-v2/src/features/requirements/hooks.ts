"use client";

import type { DecisionMaker } from "@forge/contracts/comments";
import type { RequirementKind, WritePictureRequest } from "@forge/contracts/requirement-pictures";
import { useMutation, useQuery } from "@tanstack/react-query";
import { questionsApi } from "@/features/questions";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { requirementsApi } from "./api";
import type { CreateRequirementBody, RequirementAction } from "./types";

/** Every query key the requirements feature reads under. */
export const requirementKeys = {
  list: (projectId: string | undefined) => ["requirements", projectId] as const,
  /** Every open requirement of the project: the prefix of each detail read. */
  details: (projectId: string | undefined) => ["requirement", projectId] as const,
  detail: (projectId: string | undefined, req: string | undefined) => ["requirement", projectId, req] as const,
  decisions: (projectId: string | undefined, req?: string) => ["requirement-decisions", projectId, req] as const,
  areas: (projectId: string | undefined) => ["requirement-areas", projectId] as const,
};

export const requirementQueries = {
  list: (projectId: string | undefined) => readOf(requirementKeys.list(projectId), () => requirementsApi.list(projectId as string)),
  detail: (projectId: string | undefined, req: string | undefined) =>
    readOf(requirementKeys.detail(projectId, req), () => requirementsApi.get(projectId as string, req as string)),
  areas: (projectId: string | undefined) => readOf(requirementKeys.areas(projectId), () => requirementsApi.areas(projectId as string).then((r) => r.areas), 60_000),
};

export const useRequirements = (projectId: string | undefined) => useQuery(requirementQueries.list(projectId));
export const useRequirement = (projectId: string | undefined, req: string | undefined) => useQuery(requirementQueries.detail(projectId, req));
export const useRequirementAreas = (projectId: string | undefined) => useQuery(requirementQueries.areas(projectId));

export function useRequirementDecisions(projectId: string | undefined, req: string | undefined, by: DecisionMaker = "people") {
  return useQuery({
    ...readOf([...requirementKeys.decisions(projectId, req), by], () => requirementsApi.decisions(projectId as string, req as string, by)),
    // switching whose records show keeps the open fold standing on the rows it had, not a loader;
    // only the same requirement's rows, so another requirement never wears this one's decisions
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (projectId ?? "") && previousQuery.queryKey[2] === (req ?? "") ? previous : undefined,
  });
}

/** The requirement and the list, which every write to one requirement changes. */
const oneAndList = (projectId: string, req?: string) => [requirementKeys.list(projectId), req ? requirementKeys.detail(projectId, req) : requirementKeys.details(projectId)];

export const useCreateRequirement = (projectId: string) =>
  useWrite((body: CreateRequirementBody) => requirementsApi.create(projectId, body), { touches: [requirementKeys.list(projectId)] });

/** Propose, accept, return or agree. The detail it answers with is the one the screen shows next. */
export const useRequirementAction = (projectId: string, req: string) =>
  useWrite((action: RequirementAction) => requirementsApi.act(projectId, req, action), { shows: requirementKeys.detail(projectId, req), touches: oneAndList(projectId, req) });

/** Promotes drafts to open; the detail it answers with is the one the screen shows next, and the drafts core refused stay on `data`. */
export const usePromoteDrafts = (projectId: string, req: string) =>
  useWrite((issues: string[] | undefined) => requirementsApi.promoteDrafts(projectId, req, issues), {
    shows: requirementKeys.detail(projectId, req),
    shown: (answer) => answer.requirement,
    touches: oneAndList(projectId, req),
  });

/** Links (or, given `unlink`, unlinks) an existing issue; the requirement, the list, and the issue whose standing names it read again. */
export const useLinkRequirementIssue = (projectId: string, req: string) =>
  useWrite(
    (a: { issue: string; adoptPlan?: boolean; unlink?: boolean }) =>
      a.unlink ? requirementsApi.unlinkIssue(projectId, req, a.issue) : requirementsApi.linkIssue(projectId, req, a.issue, a.adoptPlan === true),
    { shows: requirementKeys.detail(projectId, req), touches: [...oneAndList(projectId, req), ["issues", "standing"], ["issue"]] },
  );

/** Answers a question asked of the requirement, in words; its answer reaches the requirement as a decision. */
export const useAnswerRequirementQuestion = (projectId: string, req: string) =>
  useWrite((a: { questionId: string; round: number; text: string }) => questionsApi.answer(a), {
    touches: [requirementKeys.detail(projectId, req), requirementKeys.decisions(projectId, req), ["entity-decisions", projectId, "requirement", req]],
  });

/** Sets or corrects a revision's kind (REQ-35); the requirement core answers with is shown at once. */
export const useWriteRequirementKind = (projectId: string, req: string) =>
  useWrite((a: { revision: number; kind: RequirementKind | null }) => requirementsApi.writeKind(projectId, req, a.revision, a.kind), {
    shows: requirementKeys.detail(projectId, req),
    touches: oneAndList(projectId, req),
  });

/** Draws or replaces a revision's picture (REQ-35); the requirement core answers with is shown at once. */
export const useWriteRequirementPicture = (projectId: string, req: string) =>
  useWrite((a: { revision: number; body: WritePictureRequest }) => requirementsApi.writePicture(projectId, req, a.revision, a.body), {
    shows: requirementKeys.detail(projectId, req),
    touches: oneAndList(projectId, req),
  });

/** Replaces the project's areas; the list and every requirement's area (shown by name, which a rename changes) are read again. */
export const useSetAreas = (projectId: string) =>
  useWrite((names: string[]) => requirementsApi.setAreas(projectId, names), { touches: [requirementKeys.areas(projectId), ...oneAndList(projectId)] });

/** One requirement's area and short name: set by a person, or the assistant's proposal accepted. */
export function usePlacement(projectId: string, req: string) {
  const touches = oneAndList(projectId, req);
  const set = useWrite((body: { areaId?: string | null; shortName?: string | null }) => requirementsApi.setPlacement(projectId, req, body), { touches });
  const accept = useWrite(() => requirementsApi.acceptPlacement(projectId, req), { touches });
  return { set, accept };
}

/** Accepts every waiting proposal at once, one requirement at a time. */
export const useAcceptAllPlacements = (projectId: string) =>
  useWrite(
    async (keys: string[]) => {
      for (const k of keys) await requirementsApi.acceptPlacement(projectId, k);
    },
    { touches: oneAndList(projectId) },
  );

export const useProposePlacements = (projectId: string) => useMutation({ mutationFn: () => requirementsApi.proposePlacements(projectId) });
