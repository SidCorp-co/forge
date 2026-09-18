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

// cm:edge contract -> packages/core/src/issues/transition-reason.ts — mirrors REASON_REQUIRED_STATUSES; a status added there but not here fires the mutation without a reason and the user sees a 422 they cannot act on
export const REASON_REQUIRED = new Set<string>(["reopen", "waiting", "needs_info"]);

// cm:guard these three report the ACTION a person just took and deliberately do not name a status,
// which is why ISS-1097 left them alone while it took the lane word off the default toast below.
// "Information requested" says what happened; "Moved to Needs info" would say less, not more.
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

  // cm:guard this is the ONLY place a status change may be fired from the client (RFC 0002 INV-8) — a surface that calls `useTransitionIssue().mutate` itself skips the dialog, and the three stopping statuses then answer 422 on a button the user cannot satisfy
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
    // cm:guard every transition path must confirm out loud, this one included — picking `open` silently starts a whole pipeline run, and the UI said nothing about it (reported live 2026-08-14)
    transition.mutate(
      { id, toStatus },
      {
        // cm:guard the DEFAULT toast names the KERNEL status it moved to, not the lane word: it reported "Moved to Running" for a move to `developed`, `testing` or `releasing` alike until ISS-1097, so the one line confirming what just happened could not say what just happened. A caller's own `successMessage` still wins, and the reason-required branch above keeps its action wording.
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
