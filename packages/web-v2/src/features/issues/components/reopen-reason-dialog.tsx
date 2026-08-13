// RFC 0002 INV-8 — a reopen carries its rationale. The server rejects a
// `reopen` transition with no reason (422 REOPEN_REASON_REQUIRED), so every
// reopen surface on this screen routes through here rather than firing the
// mutation and surfacing a 422 toast.

"use client";

import { useEffect, useState } from "react";
import { Button, Field, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";

interface ReopenReasonDialogProps {
  open: boolean;
  loading: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export function ReopenReasonDialog({
  open,
  loading,
  onConfirm,
  onClose,
}: ReopenReasonDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const trimmed = reason.trim();

  return (
    <SlideOver open={open} onClose={onClose} title="Reopen this issue" width={480}>
      <div className="flex h-full flex-col gap-4">
        <p className="fg-body-sm text-muted">
          The reason is posted as a comment before the status flips, and it is what the fix step
          scopes its patch against — so say what regressed or what is still wrong.
        </p>
        <Field label="Reason" required>
          <Textarea
            rows={6}
            value={reason}
            placeholder="e.g. the login redirect still 500s on a fresh session — see the trace in the last comment"
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
            onClick={() => onConfirm(trimmed)}
          >
            Reopen
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
