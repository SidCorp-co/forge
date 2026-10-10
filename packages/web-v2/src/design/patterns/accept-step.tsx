"use client";

import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { Button } from "../primitives/button";
import { Input } from "../primitives/input";

interface AcceptStepProps {
  /** The confirming button, named as the act it takes ("Accept", "Agree r1"). */
  confirmLabel: string;
  /** One line saying what confirming does, read before it is pressed. */
  consequence?: string;
  /** The reason field's accessible label, named for the act ("Why it is agreed, …"); an accept's by default. */
  reasonLabel?: string;
  loading?: boolean;
  /** The act refuses an empty reason (an agree, a re-pin: REQ-4 BC-4), so the confirm stays off until one is typed. */
  reasonRequired?: boolean;
  /** The trimmed reason, or undefined where the field was left empty. */
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * The confirm step an accept of work opens (ISS-281, FB-16): what accepting does, the person's reason
 * and the authority they accept under, then the act or Cancel. The reason is optional where the route
 * keeps it so (ISS-84) and required where it refuses an empty one (`reasonRequired`); where it is given
 * it is sent and kept on the act. Three accepts do not open
 * it: a release Approve (`release-batch/approvals.ts:parseDecision` refuses a reason on an approve), a
 * design Approve ("Approve with a note" carries its conditions, FB-68) and an invitation accept, which
 * is membership rather than an act on work. While it is open, the button that opened it is off, so a
 * second press cannot close it and drop the typed reason; Cancel closes it.
 */
export function AcceptStep({ confirmLabel, consequence, reasonLabel, loading = false, reasonRequired = false, onConfirm, onCancel }: AcceptStepProps) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  return (
    <form
      className="grid gap-1.5"
      data-testid="accept-step"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(reason.trim() || undefined);
      }}
    >
      {consequence ? <p className="text-12 text-muted">{consequence}</p> : null}
      <span className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={reasonLabel ?? t("common.acceptWhyLabel")}
          placeholder={t(reasonRequired ? "common.acceptWhyRequired" : "common.acceptWhy")}
          required={reasonRequired}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-w-[16rem] flex-1"
          // the step opens on the reader's own click, so focus moves to the field it revealed
          ref={(el) => el?.focus()}
        />
        <Button type="submit" size="sm" variant="primary" disabled={reasonRequired && !reason.trim()} loading={loading}>
          {confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </span>
    </form>
  );
}
