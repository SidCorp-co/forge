// RFC 0002 INV-8 — the statuses that stop or end the work carry the reason they
// did (`issue-machine.ts:REASON_REQUIRED_STATUSES`: reopen, needs_info, on_hold, dropped).
// The server rejects the write without one (422 TRANSITION_REASON_REQUIRED, plus
// WAITING_KIND_REQUIRED for `needs_info`), so every surface that offers these
// routes through here rather than firing the mutation and surfacing a 422 toast.

"use client";

import type { REASON_REQUIRED_STATUSES } from "@forge/contracts/issue-machine";
import { useEffect, useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { IssueStatus, WaitingCause } from "../types";

export type ReasonStatus = (typeof REASON_REQUIRED_STATUSES)[number];
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

const copyOf = (t: Copy, mode: DialogMode): CopySpec => ({
  title: t(`issues.reason.${mode}.title`),
  confirm: t(`issues.reason.${mode}.confirm`),
  blurb: t(`issues.reason.${mode}.blurb`),
  placeholder: t(`issues.reason.${mode}.placeholder`),
});

const KIND_ORDER: WaitingCause[] = ["needs_answer", "needs_decision", "needs_resource"];
/** What each kind asks of the person, after the legend's own word for it. */
const kindLabel = (t: Copy, k: WaitingCause): string => `${t(`issues.waitingKind.${k}`)} — ${t(`issues.waitingKind.${k}.asks`)}`;

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
  const t = useCopy();
  const L = useLabel();

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
  const copy = copyOf(t, status);
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
            {openQuestions === 1 ? t("issues.reason.openOne") : t("issues.reason.openMany", { n: openQuestions })}
          </p>
        )}
        {picking && (
          <Field label={t("issues.reason.moveTo")} required>
            <RadioGroup
              name="moveAnywayTarget"
              value={target ?? ""}
              onChange={(v) => setTarget(v as IssueStatus)}
            >
              {(targets ?? []).map((to) => (
                <Radio key={to} value={to} label={L("issueStatus", to)} />
              ))}
            </RadioGroup>
          </Field>
        )}
        {asksKind && (
          <Field label={t("issues.reason.whatNeeded")} required>
            <RadioGroup
              name="waitingKind"
              value={kind}
              onChange={(v) => setKind(v as WaitingCause)}
            >
              {KIND_ORDER.map((k) => (
                <Radio key={k} value={k} label={kindLabel(t, k)} />
              ))}
            </RadioGroup>
          </Field>
        )}
        <Field label={t("issues.reason.reason")} required>
          <Textarea
            rows={6}
            value={reason}
            placeholder={copy.placeholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            {t("common.cancel")}
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
