// RFC 0002 INV-8 — the three statuses that STOP the pipeline carry the reason
// they stopped it. The server rejects the write without one (422
// TRANSITION_REASON_REQUIRED, plus WAITING_KIND_REQUIRED for `waiting`), so
// every surface that offers these three routes through here rather than firing
// the mutation and surfacing a 422 toast.

"use client";

import { useEffect, useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import type { WaitingCause } from "../types";

export type ReasonStatus = "reopen" | "waiting" | "needs_info";

interface CopySpec {
  title: string;
  confirm: string;
  blurb: string;
  placeholder: string;
}

const COPY: Record<ReasonStatus, CopySpec> = {
  reopen: {
    title: "Reopen this issue",
    confirm: "Reopen",
    blurb:
      "Posted as a comment before the status flips, and it is what the fix step scopes its patch against — say what regressed or what is still wrong.",
    placeholder: "e.g. the login redirect still 500s on a fresh session — trace in the last comment",
  },
  waiting: {
    title: "Park this issue for a human",
    confirm: "Park",
    // cm:guard plain prose only — this string renders in a bare <p>, so markdown backticks reach the user as literal characters (caught on forge-beta 2026-08-14); the same applies to every blurb and placeholder in this file
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
};

const KIND_LABEL: Record<WaitingCause, string> = {
  needs_decision: "A decision — someone has to choose",
  needs_resource: "A resource — someone has to supply what I cannot create",
};

interface TransitionReasonDialogProps {
  status: ReasonStatus | null;
  loading: boolean;
  onConfirm: (reason: string, waitingKind?: WaitingCause) => void;
  onClose: () => void;
}

export function TransitionReasonDialog({
  status,
  loading,
  onConfirm,
  onClose,
}: TransitionReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<WaitingCause>("needs_decision");

  useEffect(() => {
    if (status) {
      setReason("");
      setKind("needs_decision");
    }
  }, [status]);

  if (!status) return null;
  const copy = COPY[status];
  const trimmed = reason.trim();

  return (
    <SlideOver open onClose={onClose} title={copy.title} width={480}>
      <div className="flex h-full flex-col gap-4">
        <p className="fg-body-sm text-muted">{copy.blurb}</p>
        {status === "waiting" && (
          // cm:guard default the RADIO, never the SUBMITTED value — the control starts on `needs_decision` so the form is usable, but core must still receive an explicit choice; a dialog that silently sends a kind the user never looked at is the derivation RFC 0002 deleted, wearing a form
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
            loading={loading}
            disabled={trimmed.length === 0}
            onClick={() => onConfirm(trimmed, status === "waiting" ? kind : undefined)}
          >
            {copy.confirm}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
