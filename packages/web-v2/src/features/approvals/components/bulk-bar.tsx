// The bar a selection puts in place of the chips (REQ-48 BC-11): how many are selected and what
// approving them makes, counted before anything acts ("Approving makes 19 new issues · 3 requirement
// revisions · 5 closed · 10 marked Check first"), then Approve n, Decline… with one reason shared by
// every row, and Clear. A row no ✓ can approve is named as left for its peek, never guessed.

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { useEffect, useRef, useState } from "react";
import { Button, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { approveOf, bulkSummary, declineOf } from "../derive";

function Summary({ selected }: { selected: readonly NeedsYouDecision[] }) {
  const t = useCopy();
  const s = bulkSummary(selected);
  const made = s.yields.map((y) => t(y.n === 1 ? `approvals.yield.${y.kind}` : `approvals.yield.${y.kind}.many`, { n: y.n }));
  return (
    <span className="text-13 text-muted" data-testid="approval-bulk-summary">
      {made.length > 0 ? t("approvals.bulk.makes", { list: made.join(" · ") }) : t("approvals.bulk.nothing")}
      {s.checkFirst > 0 ? <span className="font-semibold text-warn-11"> · {t("approvals.bulk.checkFirst", { n: s.checkFirst })}</span> : null}
      {s.noApprove > 0 ? <span> · {t("approvals.bulk.noApprove", { n: s.noApprove })}</span> : null}
    </span>
  );
}

function SharedReason({ n, onSend, onCancel }: { n: number; onSend: (reason: string) => void; onCancel: () => void }) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const [refused, setRefused] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onSend(reason.trim());
        else setRefused(true);
      }}
    >
      <Textarea ref={fieldRef} rows={2} aria-label={t("approvals.bulk.reason")} placeholder={t("approvals.bulk.reason")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="approval-bulk-reason" />
      {refused ? (
        <p role="alert" className="text-12 text-danger-11">
          {t("approvals.declineNeeded")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" data-testid="approval-bulk-decline-send">
          {t("approvals.bulk.declineN", { n })}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          {t("approvals.act.cancel")}
        </Button>
      </div>
    </form>
  );
}

interface BulkProps {
  selected: readonly NeedsYouDecision[];
  onApprove: () => void;
  onDecline: (reason: string) => void;
  onClear: () => void;
}

export function BulkBar({ selected, onApprove, onDecline, onClear }: BulkProps) {
  const t = useCopy();
  const [declining, setDeclining] = useState(false);
  const approvable = selected.filter((d) => approveOf(d)).length;
  const declinable = selected.filter((d) => declineOf(d)).length;
  return (
    <div className="flex flex-col gap-2 border-b border-line-subtle bg-accent-tint px-5 py-3 max-md:px-3" data-testid="approval-bulk">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-14 font-semibold text-fg">{t("approvals.bulk.selected", { n: selected.length })}</span>
        <Summary selected={selected} />
      </div>
      {declining ? (
        <SharedReason
          n={declinable}
          onSend={(r) => {
            setDeclining(false);
            onDecline(r);
          }}
          onCancel={() => setDeclining(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" disabled={approvable === 0} onClick={onApprove} data-testid="approval-bulk-approve">
            {t("approvals.bulk.approve", { n: approvable })}
          </Button>
          <Button size="sm" disabled={declinable === 0} onClick={() => setDeclining(true)} data-testid="approval-bulk-decline">
            {t("approvals.bulk.decline")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear} data-testid="approval-bulk-clear">
            {t("approvals.bulk.clear")}
          </Button>
        </div>
      )}
    </div>
  );
}
