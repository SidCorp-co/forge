// The single client-side entry to `POST /issues/:id/transition`. Every surface
// offering a status change goes through `requestTransition` and renders the
// returned `dialog`; nothing calls `useTransitionIssue().mutate` directly.

"use client";

import { REASON_REQUIRED_STATUSES } from "@forge/contracts/issue-machine";
import { type ReactNode, useState } from "react";
import { useToast } from "@/providers/toast-provider";
import { statusLabel } from "../derive";
import { useTransitionIssue } from "../hooks";
import type { IssueStatus, WaitingCause } from "../types";
import {
  type DialogMode,
  type ReasonStatus,
  TransitionReasonDialog,
} from "./transition-reason-dialog";

export const REASON_REQUIRED = new Set<string>(REASON_REQUIRED_STATUSES);

const REASON_TOAST: Record<ReasonStatus, string> = {
  reopen: "Issue reopened",
  needs_info: "Information requested",
  on_hold: "Issue put on hold",
  dropped: "Issue dropped",
};

interface RequestOptions {
  successMessage?: string;
  onSuccess?: () => void;
}

export interface GuardedTransition {
  requestTransition: (id: string, toStatus: IssueStatus, opts?: RequestOptions) => void;
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
export function useGuardedTransition(): GuardedTransition {
  const transition = useTransitionIssue();
  const { toast } = useToast();
  const [prompt, setPrompt] = useState<{
    id: string;
    status: DialogMode;
    /** Where the move goes: the reason status itself, or the close/drop the questions held up. */
    target: IssueStatus;
    successMessage: string;
    onSuccess?: () => void;
    openQuestions?: number;
    targets?: IssueStatus[];
    /** The reason (and kind) already given for a reason-required move the questions then held up,
     *  re-sent with the withdrawal so the second attempt is not refused for the reason it lacks. */
    carried?: { reason: string; waitingKind?: WaitingCause };
  } | null>(null);

  const succeed = (title: string, extra?: () => void) => () => {
    toast({ title, tone: "success" });
    extra?.();
  };

  const requestTransition = (id: string, toStatus: IssueStatus, opts?: RequestOptions) => {
    if (REASON_REQUIRED.has(toStatus)) {
      setPrompt({
        id,
        status: toStatus as ReasonStatus,
        target: toStatus,
        successMessage: opts?.successMessage ?? REASON_TOAST[toStatus as ReasonStatus],
        onSuccess: opts?.onSuccess,
      });
      return;
    }
    const successMessage = opts?.successMessage ?? `Moved to ${statusLabel(toStatus)}`;
    transition.mutate(
      { id, toStatus },
      {
        onSuccess: succeed(successMessage, opts?.onSuccess),
        onOpenQuestions: (ids) =>
          setPrompt({
            id,
            status: "void_questions",
            target: toStatus,
            successMessage,
            onSuccess: opts?.onSuccess,
            openQuestions: ids.length,
          }),
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
      successMessage: opts?.successMessage ?? (mode === "not_needed" ? "Question withdrawn" : "Moved"),
      onSuccess: opts?.onSuccess,
    });
  };

  const onConfirm = (reason: string, waitingKind?: WaitingCause, picked?: IssueStatus) => {
    if (!prompt) return;
    const { id, status, successMessage, onSuccess } = prompt;
    const target = status === "move_anyway" ? (picked ?? prompt.target) : prompt.target;
    const kind = waitingKind ? { waitingKind } : {};
    const carried = prompt.carried
      ? { reason: prompt.carried.reason, ...(prompt.carried.waitingKind ? { waitingKind: prompt.carried.waitingKind } : {}) }
      : {};
    const body =
      status === "void_questions"
        ? { id, toStatus: target, voidQuestions: reason, ...carried }
        : status === "not_needed"
          ? { id, toStatus: target, reason, voidQuestions: reason }
          : { id, toStatus: target, reason, ...kind };
    const given = status === "void_questions" ? prompt.carried : { reason, ...kind };
    transition.mutate(body, {
      onSuccess: succeed(successMessage, () => {
        setPrompt(null);
        onSuccess?.();
      }),
      onOpenQuestions: (ids) =>
        setPrompt({
          id,
          status: "void_questions",
          target,
          successMessage,
          onSuccess,
          openQuestions: ids.length,
          ...(given ? { carried: given } : {}),
        }),
    });
  };

  return {
    requestTransition,
    requestParkLeave,
    isPending: transition.isPending,
    dialog: (
      <TransitionReasonDialog
        status={prompt?.status ?? null}
        openQuestions={prompt?.openQuestions}
        targets={prompt?.targets}
        loading={transition.isPending}
        onConfirm={onConfirm}
        onClose={() => setPrompt(null)}
      />
    ),
  };
}
