// RFC 0002 INV-8 — the three statuses that STOP the pipeline carry the reason
// they stopped it. The server rejects the write without one (422
// TRANSITION_REASON_REQUIRED, plus WAITING_KIND_REQUIRED for `waiting`), so
// every surface that offers these three routes through here rather than firing
// the mutation and surfacing a 422 toast.

"use client";

import { useEffect, useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { statusLabel } from "../derive";
import type { IssueStatus, WaitingCause } from "../types";

export type ReasonStatus = "reopen" | "waiting" | "needs_info";
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
  waiting: {
    title: "Park this issue for a human",
    confirm: "Park",
    blurb:
      "Parking stops the pipeline until a person acts, so it has to say what that person is being asked for. Nobody can answer a question that was never written down.",
    placeholder: "e.g. need a Stripe test account with 3DS enabled — I cannot create one",
  },
  needs_info: {
    title: "Ask for information",
    confirm: "Request info",
    blurb:
      "The question is posted as a comment before the status flips. Ask it in full here — this is the only place the reporter will see it.",
    placeholder: "e.g. which environment did you see this on, and was the user an org admin?",
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
      "An agent asked a person something on this issue and nobody has answered. Finishing the work withdraws those questions — say why they no longer matter, and that sentence is recorded on each one. To answer them instead, cancel and use their \"Decision waiting\" cards on the issue.",
    placeholder: "e.g. the fix shipped without needing the tenant — the question is moot",
  },
};

const KIND_LABEL: Record<WaitingCause, string> = {
  needs_decision: "A decision — someone has to choose",
  needs_resource: "A resource — someone has to supply what I cannot create",
};

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
  const [kind, setKind] = useState<WaitingCause>("needs_decision");
  const [target, setTarget] = useState<IssueStatus | null>(null);
  /** Set on the first confirm, so a second click before `loading` arrives sends no second move. */
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (status) {
      setReason("");
      setKind("needs_decision");
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
  const asksKind = status === "waiting" || (picking && target === "waiting");
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
              <Radio value="needs_decision" label={KIND_LABEL.needs_decision} />
              <Radio value="needs_resource" label={KIND_LABEL.needs_resource} />
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
