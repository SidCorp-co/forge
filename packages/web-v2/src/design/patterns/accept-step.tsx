"use client";

import { useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { Button } from "../primitives/button";
import { Input } from "../primitives/input";

export interface AcceptStepProps {
  /** The confirming button, named as the act it takes ("Accept", "Agree r1"). */
  confirmLabel: string;
  /** One line saying what confirming does, read before it is pressed. */
  consequence?: string;
  loading?: boolean;
  /** The trimmed reason, or undefined where the field was left empty. */
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * The confirm step every accept opens (ISS-281, FB-16): what accepting does, the person's reason and
 * the authority they accept under, then the act or Cancel. The reason is optional, as every accept
 * route keeps it (ISS-84); where it is given it is sent and kept on the act.
 */
export function AcceptStep({ confirmLabel, consequence, loading = false, onConfirm, onCancel }: AcceptStepProps) {
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
          aria-label={t("common.acceptWhyLabel")}
          placeholder={t("common.acceptWhy")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-w-[16rem] flex-1"
          autoFocus
        />
        <Button type="submit" size="sm" variant="primary" loading={loading}>
          {confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </span>
    </form>
  );
}
