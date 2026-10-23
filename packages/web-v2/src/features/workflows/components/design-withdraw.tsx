// A design no revision of which was approved can be taken back from its page: it leaves the Workflows
// list and Needs you, and core logs the act. One with an approved revision is history and offers no
// such act; core refuses it by name either way, and the refusal is drawn under the act.

import { REASON_TEXT_MAX } from "@forge/contracts/reason-text";
import { useState } from "react";
import { Button, ConfirmDialog, Field, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { workflowsHref } from "@/lib/routes/workflows";
import { useWithdrawDesign } from "../hooks";
import type { WorkflowDesign } from "../types";

/** Whether the design may still be taken back: it is in a design lifecycle, nothing of it was ever approved, and it is not gone already. */
export const withdrawable = (d: Pick<WorkflowDesign, "approvedRevision" | "status">) => d.status !== null && d.status !== "withdrawn" && d.approvedRevision === null;

export function WithdrawDesign({ projectId, slug, d }: { projectId: string; slug: string; d: WorkflowDesign }) {
  const t = useCopy();
  const router = useRouter();
  const withdraw = useWithdrawDesign(projectId, d.workflowId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!withdrawable(d)) return null;
  return (
    <div className="grid gap-1.5" data-testid="design-withdraw">
      <span>
        <Button type="button" size="sm" variant="ghost" icon="trash" onClick={() => setOpen(true)} data-testid="design-withdraw-open">
          {t("workflows.withdraw.act")}
        </Button>
      </span>
      <RefusalLine error={withdraw.error} testid="design-withdraw-refusal" />
      <ConfirmDialog
        open={open}
        title={t("workflows.withdraw.title")}
        tone="danger"
        confirmLabel={t("workflows.withdraw.confirm")}
        loading={withdraw.isPending}
        message={
          <div className="grid gap-3">
            <p className="m-0">{t("workflows.withdraw.message")}</p>
            <Field label={t("workflows.withdraw.reason")}>
              <Textarea rows={2} value={reason} maxLength={REASON_TEXT_MAX} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        }
        onClose={() => setOpen(false)}
        onConfirm={() =>
          withdraw.mutate(reason.trim() || null, {
            onSuccess: () => router.push(workflowsHref(slug)),
            onSettled: () => setOpen(false),
          })
        }
      />
    </div>
  );
}
