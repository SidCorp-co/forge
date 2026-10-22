// The single client-side entry to `POST /issues/:id/transition`. Every surface
// offering a status change goes through `requestTransition` and renders the
// returned `dialog`; nothing calls `useTransitionIssue().mutate` directly.

import { REASON_REQUIRED_STATUSES } from "@forge/contracts/issue-machine";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type AgentQuestion, questionKeys } from "@/features/questions";
import type { Refusal } from "@/lib/api/refusals";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useTransitionIssue } from "../hooks";
import type { IssueStatus, WaitingCause } from "../types";
import { ChecklistDialog, type ChecklistPrompt, checklistPromptOf, givenAnswers } from "./checklist-dialog";
import { answersForMove, checklistDraft, forgetChecklistDrafts, keepChecklistDraft } from "./checklist-drafts";
import { endsTheIssue, openQuestionsOf } from "./moot-questions";
import {
  type DialogMode,
  type ReasonStatus,
  TransitionReasonDialog,
} from "./transition-reason-dialog";

const REASON_REQUIRED = new Set<string>(REASON_REQUIRED_STATUSES);


interface RequestOptions {
  successMessage?: string;
  onSuccess?: () => void;
}

/** The issue a move is asked of, at the status this screen reads it at. */
interface MovedIssue {
  id: string;
  status: IssueStatus;
}

interface GuardedTransition {
  requestTransition: (issue: MovedIssue, toStatus: IssueStatus, opts?: RequestOptions) => void;
  /** ISS-1310 — Move anyway (pick from `targets`) or Not needed (void, then resume at `targets[0]`); both ask why. */
  requestParkLeave: (
    id: string,
    mode: "move_anyway" | "not_needed",
    targets: IssueStatus[],
    opts?: RequestOptions,
  ) => void;
  dialog: ReactNode;
  isPending: boolean;
}

/**
 * Routes the reason-required statuses through {@link TransitionReasonDialog}
 * and fires every other status straight at the endpoint — both paths confirm
 * with a toast on success.
 */
/** A move that asks for a reason first, and what it carries into the dialog. */
interface ReasonPrompt {
  id: string;
  status: DialogMode;
  /** Where the move goes: the reason status itself, or the close the questions held up. */
  target: IssueStatus;
  successMessage: string;
  onSuccess?: () => void;
  targets?: IssueStatus[];
}

/** A move its checklist refused, held open so the person answers and moves it again. */
type ChecklistHold = ChecklistPrompt & {
  id: string;
  from: IssueStatus;
  toStatus: IssueStatus;
  successMessage: string;
  onSuccess?: () => void;
};

/**
 * What a confirmed reason sends. A close or drop made while the dialog lists open questions voids
 * them with the reason the person typed, in the same move (ISS-560): `open` is that list.
 */
function reasonMove(
  prompt: ReasonPrompt,
  reason: string,
  open: readonly AgentQuestion[],
  waitingKind?: WaitingCause,
  picked?: IssueStatus,
) {
  const { id, status } = prompt;
  const target = status === "move_anyway" ? (picked ?? prompt.target) : prompt.target;
  const kind = waitingKind ? { waitingKind } : {};
  const voids = endsTheIssue(target) && open.length > 0 ? { voidQuestions: reason } : {};
  if (status === "void_questions") return { target, body: { id, toStatus: target, voidQuestions: reason } };
  if (status === "not_needed") return { target, body: { id, toStatus: target, reason, voidQuestions: reason } };
  return { target, body: { id, toStatus: target, reason, ...kind, ...voids } };
}

export function useGuardedTransition(): GuardedTransition {
  const transition = useTransitionIssue();
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  const L = useLabel();
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);

  const [checklist, setChecklist] = useState<ChecklistHold | null>(null);

  /** What the person typed into the open checklist form; mirrored into its draft on every keystroke. */
  const [typed, setTyped] = useState<Record<string, string>>({});

  const askChecklist =
    (id: string, from: IssueStatus, toStatus: IssueStatus, successMessage: string, onSuccess?: () => void) =>
    (refusals: Refusal[]) => {
      const prompt = checklistPromptOf(refusals);
      if (prompt) {
        setTyped(checklistDraft(id, from, toStatus));
        setChecklist({ ...prompt, id, from, toStatus, successMessage, onSuccess });
        return;
      }
      // answers refused with no checklist to hold them were typed for a move the issue no longer takes
      forgetChecklistDrafts(id);
      toast({ title: t("issues.toast.updateFailed"), description: refusals.map((r) => r.detail).join(" "), tone: "error" });
    };

  const typeAnswer = (question: string, value: string) => {
    if (!checklist) return;
    const next = { ...typed, [question]: value };
    keepChecklistDraft(checklist.id, checklist.from, checklist.toStatus, next);
    setTyped(next);
  };

  const answerChecklist = (answers: Record<string, string>) => {
    if (!checklist) return;
    const { id, from, toStatus, successMessage, onSuccess } = checklist;
    transition.mutate(
      { id, toStatus, answers },
      {
        onSuccess: succeed(successMessage, () => {
          forgetChecklistDrafts(id); // the issue moved: what was typed for any move of it is spent
          setChecklist(null);
          onSuccess?.();
        }),
        onChecklist: askChecklist(id, from, toStatus, successMessage, onSuccess),
      },
    );
  };

  /** The open questions the dialog lists for `id`: the read `MootQuestions` draws. */
  const listedOpen = (id: string) =>
    openQuestionsOf(qc.getQueryData<{ questions: AgentQuestion[] }>(questionKeys.issue(id))?.questions);
  /** A question asked after the list was read: read it again, so the dialog shows what the move met. */
  const relist = (id: string) => () => void qc.invalidateQueries({ queryKey: questionKeys.issue(id) });

  const succeed = (title: string, extra?: () => void) => () => {
    toast({ title, tone: "success" });
    extra?.();
  };

  const requestTransition = ({ id, status: from }: MovedIssue, toStatus: IssueStatus, opts?: RequestOptions) => {
    if (REASON_REQUIRED.has(toStatus)) {
      setPrompt({
        id,
        status: toStatus as ReasonStatus,
        target: toStatus,
        successMessage: opts?.successMessage ?? t(`issues.toast.${toStatus as ReasonStatus}`),
        onSuccess: opts?.onSuccess,
      });
      return;
    }
    const successMessage = opts?.successMessage ?? t("issues.toast.movedTo", { status: L("issueStatus", toStatus) });
    // answers the person already typed for this very move go with it, even when the form is not open
    const answers = givenAnswers(answersForMove(id, from, toStatus));
    transition.mutate(
      { id, toStatus, ...(Object.keys(answers).length > 0 ? { answers } : {}) },
      {
        onSuccess: succeed(successMessage, () => {
          forgetChecklistDrafts(id);
          opts?.onSuccess?.();
        }),
        onOpenQuestions: () => {
          relist(id)();
          setPrompt({ id, status: "void_questions", target: toStatus, successMessage, onSuccess: opts?.onSuccess });
        },
        onChecklist: askChecklist(id, from, toStatus, successMessage, opts?.onSuccess),
      },
    );
  };

  const requestParkLeave: GuardedTransition["requestParkLeave"] = (id, mode, targets, opts) => {
    const first = targets[0];
    if (!first) return;
    setPrompt({
      id,
      status: mode,
      target: first,
      targets,
      successMessage: opts?.successMessage ?? (mode === "not_needed" ? t("issues.toast.withdrawn") : t("issues.toast.moved")),
      onSuccess: opts?.onSuccess,
    });
  };

  const onConfirm = (reason: string, waitingKind?: WaitingCause, picked?: IssueStatus) => {
    if (!prompt) return;
    const { id, successMessage, onSuccess } = prompt;
    const { body } = reasonMove(prompt, reason, listedOpen(id), waitingKind, picked);
    transition.mutate(body, {
      onSuccess: succeed(successMessage, () => {
        forgetChecklistDrafts(id);
        setPrompt(null);
        onSuccess?.();
      }),
      // the same dialog stays open with the reason typed, now listing the question the move met
      onOpenQuestions: relist(id),
    });
  };

  return {
    requestTransition,
    requestParkLeave,
    isPending: transition.isPending,
    dialog: (
      <>
      <ChecklistDialog
        prompt={checklist}
        answers={typed}
        onAnswer={typeAnswer}
        loading={transition.isPending}
        onConfirm={answerChecklist}
        onClose={() => setChecklist(null)}
      />
      <TransitionReasonDialog
        status={prompt?.status ?? null}
        issueId={prompt?.id}
        moveTo={prompt?.target}
        targets={prompt?.targets}
        loading={transition.isPending}
        failure={transition.error}
        onConfirm={onConfirm}
        onClose={() => setPrompt(null)}
      />
      </>
    ),
  };
}
