// RFC 0002 INV-8 — the statuses that stop or end the work carry the reason they
// did (`REASON_REQUIRED_ISSUE_STATUSES`: reopen, needs_info, on_hold, dropped).
// The server rejects the write without one (422 TRANSITION_REASON_REQUIRED, plus
// WAITING_KIND_REQUIRED for `needs_info`), so every surface that offers these
// routes through here rather than firing the mutation and surfacing a 422 toast.

"use client";

import { NEEDS_INFO_KIND_LABELS } from "@forge/contracts/issue-vocabulary";
import type { REASON_REQUIRED_ISSUE_STATUSES } from "@forge/contracts/status-sets";
import { useEffect, useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { statusLabel } from "../derive";
import type { IssueStatus, WaitingCause } from "../types";

export type ReasonStatus = (typeof REASON_REQUIRED_ISSUE_STATUSES)[number];
/**
 * ISS-1257 — a close or drop the server refused because questions on the issue are still open.
 * ISS-1310 — the two ways out of a park that leave its question unanswered, each asking why.
 */
export type DialogMode = ReasonStatus | "void_questions" | "move_anyway" | "not_needed";

interface CopySpec {
  title: string;
  confirm: string;
  blurb: string;
  placeholder: string;
}

const COPY: Record<DialogMode, CopySpec> = {
  reopen: {
    title: "Reopen this issue",
    confirm: "Reopen",
    blurb:
      "Posted as a comment before the status flips, where whoever picks the work back up reads it — say what regressed or what is still wrong.",
    placeholder: "e.g. the login redirect still 500s on a fresh session — trace in the last comment",
  },
  needs_info: {
    title: "Stop this issue on a person",
    confirm: "Request info",
    blurb:
      "The work stops until a person acts, so say what they are being asked for — posted as a comment before the status flips. Nobody can answer a question that was never written down.",
    placeholder: "e.g. which environment did you see this on, and was the user an org admin?",
  },
  on_hold: {
    title: "Put this issue on hold",
    confirm: "Hold",
    blurb:
      "A hold pauses the work deliberately until someone resumes it where it stopped. Say why, so whoever picks it up knows whether the reason still stands.",
    placeholder: "e.g. paused until the billing migration lands next sprint",
  },
  dropped: {
    title: "Drop this issue",
    confirm: "Drop",
    blurb:
      "Dropping says this work will not be done. The reason is posted on the thread, where anyone who finds the issue later reads why.",
    placeholder: "e.g. superseded by ISS-412, which covers the same flow",
  },
  move_anyway: {
    title: "Move this issue anyway",
    confirm: "Move",
    blurb:
      "This moves the issue on without what it is waiting for. Say why in one line: it is posted on the thread, where the next run reads it before it stops the issue again.",
    placeholder: "e.g. settled on the call — the build can go on without the tenant",
  },
  not_needed: {
    title: "The question is not needed any more",
    confirm: "Withdraw it and resume",
    blurb:
      "Withdraws the open question with your reason and resumes the issue where its work stopped, in one move. The reason is posted on the thread and kept on the question.",
    placeholder: "e.g. the owner decided in standup — ship the smaller reading",
  },
  void_questions: {
    title: "Questions are still open on this issue",
    confirm: "Withdraw them and continue",
    blurb:
      "An agent asked a person something on this issue and nobody has answered. Finishing the work withdraws those questions — say why they no longer matter, and that sentence is recorded on each one. To answer them instead, cancel and use the Decisions panel on the issue.",
    placeholder: "e.g. the fix shipped without needing the tenant — the question is moot",
  },
};

/** What each kind asks of the person, after the legend's own word for it. */
const KIND_ASKS: Record<WaitingCause, string> = {
  needs_answer: "someone has to answer it",
  needs_decision: "someone has to choose",
  needs_resource: "someone has to supply what I cannot create",
};
const KIND_ORDER: WaitingCause[] = ["needs_answer", "needs_decision", "needs_resource"];
const kindLabel = (k: WaitingCause): string => `${NEEDS_INFO_KIND_LABELS[k]} — ${KIND_ASKS[k]}`;

interface TransitionReasonDialogProps {
  status: DialogMode | null;
  /** How many open questions a `void_questions` confirm withdraws. */
  openQuestions?: number;
  /** Every target a `move_anyway` may pick, the transitions map unchanged. */
  targets?: IssueStatus[];
  loading: boolean;
  onConfirm: (reason: string, waitingKind?: WaitingCause, target?: IssueStatus) => void;
  onClose: () => void;
}

export function TransitionReasonDialog({
  status,
  openQuestions,
  targets,
  loading,
  onConfirm,
  onClose,
}: TransitionReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<WaitingCause>("needs_answer");
  const [target, setTarget] = useState<IssueStatus | null>(null);
  /** Set on the first confirm, so a second click before `loading` arrives sends no second move. */
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (status) {
      setReason("");
      setKind("needs_answer");
      setTarget(null);
      setSent(false);
    }
  }, [status]);
  useEffect(() => {
    if (!loading) setSent(false);
  }, [loading]);

  if (!status) return null;
  const copy = COPY[status];
  const trimmed = reason.trim();
  const picking = status === "move_anyway";
  const asksKind = status === "needs_info" || (picking && target === "needs_info");
  const ready = trimmed.length > 0 && (!picking || target !== null);

  return (
    <SlideOver open onClose={onClose} title={copy.title} width={480}>
      <div className="flex h-full flex-col gap-4">
        <p className="fg-body-sm text-muted">{copy.blurb}</p>
        {status === "void_questions" && openQuestions !== undefined && (
          <p className="fg-body-sm text-fg">
            {openQuestions === 1 ? "1 question is" : `${openQuestions} questions are`} open.
          </p>
        )}
        {picking && (
          <Field label="Move to" required>
            <RadioGroup
              name="moveAnywayTarget"
              value={target ?? ""}
              onChange={(v) => setTarget(v as IssueStatus)}
            >
              {(targets ?? []).map((to) => (
                <Radio key={to} value={to} label={statusLabel(to)} />
              ))}
            </RadioGroup>
          </Field>
        )}
        {asksKind && (
          <Field label="What is needed" required>
            <RadioGroup
              name="waitingKind"
              value={kind}
              onChange={(v) => setKind(v as WaitingCause)}
            >
              {KIND_ORDER.map((k) => (
                <Radio key={k} value={k} label={kindLabel(k)} />
              ))}
            </RadioGroup>
          </Field>
        )}
        <Field label="Reason" required>
          <Textarea
            rows={6}
            value={reason}
            placeholder={copy.placeholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={loading || sent}
            disabled={!ready || sent}
            onClick={() => {
              if (sent) return;
              setSent(true);
              const kindSent = asksKind ? kind : undefined;
              if (picking && target) onConfirm(trimmed, kindSent, target);
              else onConfirm(trimmed, kindSent);
            }}
          >
            {copy.confirm}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
