// The single client-side entry to `POST /issues/:id/transition`. Every surface
// offering a status change goes through `requestTransition` and renders the
// returned `dialog`; nothing calls `useTransitionIssue().mutate` directly.

"use client";

import { type ReactNode, useState } from "react";
import { useToast } from "@/providers/toast-provider";
import { statusLabel } from "../derive";
import { useTransitionIssue } from "../hooks";
import type { IssueStatus, WaitingCause } from "../types";
import { type ReasonStatus, TransitionReasonDialog } from "./transition-reason-dialog";

export const REASON_REQUIRED = new Set<string>(["reopen", "waiting", "needs_info"]);

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
  const [prompt, setPrompt] = useState<
    { id: string; status: ReasonStatus; successMessage: string; onSuccess?: () => void } | null
  >(null);

  const succeed = (title: string, extra?: () => void) => () => {
    toast({ title, tone: "success" });
    extra?.();
  };

  const requestTransition = (id: string, toStatus: IssueStatus, opts?: RequestOptions) => {
    if (REASON_REQUIRED.has(toStatus)) {
      setPrompt({
        id,
        status: toStatus as ReasonStatus,
        successMessage: opts?.successMessage ?? REASON_TOAST[toStatus as ReasonStatus],
        onSuccess: opts?.onSuccess,
      });
      return;
    }
    transition.mutate(
      { id, toStatus },
      {
        onSuccess: succeed(opts?.successMessage ?? `Moved to ${statusLabel(toStatus)}`, opts?.onSuccess),
      },
    );
  };

  const onConfirm = (reason: string, waitingKind?: WaitingCause) => {
    if (!prompt) return;
    const { id, status, successMessage, onSuccess } = prompt;
    transition.mutate(
      { id, toStatus: status, reason, ...(waitingKind ? { waitingKind } : {}) },
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
        loading={transition.isPending}
        onConfirm={onConfirm}
        onClose={() => setPrompt(null)}
      />
    ),
  };
}
