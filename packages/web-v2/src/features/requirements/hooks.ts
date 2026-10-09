"use client";

import type { DecisionMaker } from "@forge/contracts/comments";
import type { RequirementKind, WritePictureRequest } from "@forge/contracts/requirement-pictures";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { questionsApi } from "@/features/questions/api";
import { requirementsApi } from "./api";
import type { CreateRequirementBody, RequirementAction, RequirementDetail } from "./types";

export function useRequirements(projectId: string | undefined) {
  return useQuery({
    queryKey: ["requirements", projectId ?? ""],
    queryFn: () => requirementsApi.list(projectId as string),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}

export function useRequirement(projectId: string | undefined, req: string | undefined) {
  return useQuery({
    queryKey: ["requirement", projectId ?? "", req ?? ""],
    queryFn: () => requirementsApi.get(projectId as string, req as string),
    enabled: Boolean(projectId && req),
    staleTime: 15_000,
  });
}

export function useCreateRequirement(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequirementBody) => requirementsApi.create(projectId, body),
    // started, not awaited: a returned refetch keeps the form pending until the whole list is read again
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
    },
  });
}

/** Propose, accept, return or agree. The detail it answers with is the one the screen shows next. */
export function useRequirementAction(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: RequirementAction) => requirementsApi.act(projectId, req, action),
    onSuccess: (detail: RequirementDetail) => qc.setQueryData(["requirement", projectId, req], detail),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
    },
  });
}

/** Promotes drafts to open; the detail it answers with is the one the screen shows next, and the drafts core refused stay on `data`. */
export function usePromoteDrafts(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (issues: string[] | undefined) => requirementsApi.promoteDrafts(projectId, req, issues),
    onSuccess: (answer) => qc.setQueryData(["requirement", projectId, req], answer.requirement),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
    },
  });
}

export function useRequirementDecisions(projectId: string | undefined, req: string | undefined, by: DecisionMaker = "people") {
  return useQuery({
    queryKey: ["requirement-decisions", projectId ?? "", req ?? "", by],
    queryFn: () => requirementsApi.decisions(projectId as string, req as string, by),
    enabled: Boolean(projectId && req),
    staleTime: 15_000,
    // switching whose records show keeps the open fold standing on the rows it had, not a loader;
    // only the same requirement's rows, so another requirement never wears this one's decisions
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (projectId ?? "") && previousQuery.queryKey[2] === (req ?? "") ? previous : undefined,
  });
}

/** What a link or unlink touches: the requirement, the list, and the issue whose standing names it. */
function invalidateLinked(qc: ReturnType<typeof useQueryClient>, projectId: string, req: string) {
  qc.invalidateQueries({ queryKey: ["requirements", projectId] });
  qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
  qc.invalidateQueries({ queryKey: ["issues", "standing"] });
  qc.invalidateQueries({ queryKey: ["issue"] });
}

/** Links (or, given `unlink`, unlinks) an existing issue; the detail it answers with is the one the screen shows next. */
export function useLinkRequirementIssue(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { issue: string; adoptPlan?: boolean; unlink?: boolean }) =>
      a.unlink ? requirementsApi.unlinkIssue(projectId, req, a.issue) : requirementsApi.linkIssue(projectId, req, a.issue, a.adoptPlan === true),
    onSuccess: (detail: RequirementDetail) => qc.setQueryData(["requirement", projectId, req], detail),
    onSettled: () => invalidateLinked(qc, projectId, req),
  });
}

/** Answers a question asked of the requirement, in words; its answer reaches the requirement as a decision. */
export function useAnswerRequirementQuestion(projectId: string, req: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { questionId: string; round: number; text: string }) => questionsApi.answer(a),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
      qc.invalidateQueries({ queryKey: ["requirement-decisions", projectId, req] });
      qc.invalidateQueries({ queryKey: ["entity-decisions", projectId, "requirement", req] });
    },
  });
}

/** The requirement core answers a picture or kind write with, shown at once; the list's rows re-read. */
function useShowWritten(projectId: string, req: string) {
  const qc = useQueryClient();
  return {
    onSuccess: (d: RequirementDetail) => qc.setQueryData(["requirement", projectId, req], d),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["requirements", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement", projectId, req] });
    },
  };
}

/** Sets or corrects a revision's kind (REQ-35). */
export function useWriteRequirementKind(projectId: string, req: string) {
  const shown = useShowWritten(projectId, req);
  return useMutation({
    mutationFn: (a: { revision: number; kind: RequirementKind | null }) => requirementsApi.writeKind(projectId, req, a.revision, a.kind),
    ...shown,
  });
}

/** Draws or replaces a revision's picture (REQ-35). */
export function useWriteRequirementPicture(projectId: string, req: string) {
  const shown = useShowWritten(projectId, req);
  return useMutation({
    mutationFn: (a: { revision: number; body: WritePictureRequest }) => requirementsApi.writePicture(projectId, req, a.revision, a.body),
    ...shown,
  });
}
