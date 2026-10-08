"use client";

import { useState } from "react";
import { Button, Input } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/**
 * The step a Reject of a suggestion opens, in the requirement's Review view and the requirements list's
 * assistant strip alike: the reason is required, as core's reject route refuses one left empty, and it is
 * kept on the suggestion and shown in the item's history. Nothing is sent until it is submitted.
 */
export function RejectStep({ loading = false, onConfirm, onCancel }: { loading?: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="reject-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onConfirm(reason.trim());
      }}
    >
      <Input
        aria-label={t("requirements.suggestion.rejectWhy")}
        placeholder={t("requirements.suggestion.rejectWhy")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="min-w-[16rem] flex-1"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={!reason.trim()} loading={loading}>
        {t("requirements.act.reject")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </form>
  );
}
