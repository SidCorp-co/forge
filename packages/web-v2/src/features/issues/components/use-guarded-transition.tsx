// The single client-side entry to `POST /issues/:id/transition`. Every surface
// offering a status change goes through `requestTransition` and renders the
// returned `dialog`; nothing calls `useTransitionIssue().mutate` directly.

"use client";

import { REASON_REQUIRED_ISSUE_STATUSES } from "@forge/contracts/status-sets";
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

export const REASON_REQUIRED = new Set<string>(REASON_REQUIRED_ISSUE_STATUSES);

const REASON_TOAST: Record<ReasonStatus, string> = {
  reopen: "Issue reopened",
  waiting: "Issue parked for a human",
  needs_info: "Information requested",
};

interface RequestOptions {
  successMessage?: string;
  onSuccess?: () => void;
}

export interface GuardedTransition {
  requestTransition: (id: string, toStatus: IssueStatus, opts?: RequestOptions) => void;
  dialog: ReactNode;
  isPending: boolean;
}

/**
 * Routes the three reason-required statuses through {@link TransitionReasonDialog}
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

  const onConfirm = (reason: string, waitingKind?: WaitingCause) => {
    if (!prompt) return;
    const { id, status, target, successMessage, onSuccess } = prompt;
    const body =
      status === "void_questions"
        ? { id, toStatus: target, voidQuestions: reason }
        : { id, toStatus: target, reason, ...(waitingKind ? { waitingKind } : {}) };
    transition.mutate(
      body,
      {
        onSuccess: succeed(successMessage, () => {
          setPrompt(null);
          onSuccess?.();
        }),
      },
    );
  };

  return {
    requestTransition,
    isPending: transition.isPending,
    dialog: (
      <TransitionReasonDialog
        status={prompt?.status ?? null}
        openQuestions={prompt?.openQuestions}
        loading={transition.isPending}
        onConfirm={onConfirm}
        onClose={() => setPrompt(null)}
      />
    ),
  };
}
