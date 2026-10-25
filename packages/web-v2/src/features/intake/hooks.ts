import { useQuery } from "@tanstack/react-query";
import { readOf, useWrite } from "@/lib/api/query-kit";
import { intakeApi } from "./api";
import type { IntakeAnswerRequest, IntakeDraftView, IntakeKeepRequest } from "./types";

/** The outbox's first retries land 10 to 60 s apart, so a retrying draft is read about that often. */
const RETRY_POLL_MS = 15_000;
/** A held check whose blocking questions are all answered is being drafted again: read it until it ends. */
const REDRAFT_POLL_MS = 5_000;

const draftKey = (projectId: string | undefined, ref: string | undefined) => ["intake-draft", projectId, ref] as const;

/** Every blocking question answered while the check still holds: the assistant is drafting it again. */
export function isRedrafting(draft: IntakeDraftView | null | undefined): boolean {
  if (!draft?.value || draft.value.outcome !== null) return false;
  const blocking = draft.questions.filter((q) => q.blocks !== null);
  return blocking.length > 0 && blocking.every((q) => q.answer !== null);
}

/** The draft the intake assistant made when the item was created, read again while a retry or a redraft is owed. */
export function useIntakeDraft(projectId: string | undefined, ref: string | undefined) {
  return useQuery({
    ...readOf(draftKey(projectId, ref), () => intakeApi.draft(projectId as string, ref as string), 10_000),
    refetchInterval: (query) => {
      const draft = query.state.data?.draft;
      if (draft?.retrying) return RETRY_POLL_MS;
      return isRedrafting(draft) ? REDRAFT_POLL_MS : false;
    },
  });
}

/** The item's own reads that an answer or a keep changes: its status, its checklist, its triage. */
const itemReads = (projectId: string, ref: string) =>
  ref.startsWith("REQ-") ? [["requirement", projectId, ref], ["requirements", projectId]] : [["feedback-item", projectId, ref], ["feedback", projectId]];

/** Answers one question of the item's draft; the draft core answers with is shown at once. */
export const useAnswerIntakeQuestion = (projectId: string, ref: string) =>
  useWrite((body: IntakeAnswerRequest) => intakeApi.answer(projectId, ref, body), {
    shows: draftKey(projectId, ref),
    touches: itemReads(projectId, ref),
  });

/** Keeps a refused requirement; the draft core answers with is shown at once and the requirement read again. */
export const useKeepRefusedRequest = (projectId: string, ref: string) =>
  useWrite((body: IntakeKeepRequest) => intakeApi.keep(projectId, ref, body), {
    shows: draftKey(projectId, ref),
    touches: itemReads(projectId, ref),
  });
