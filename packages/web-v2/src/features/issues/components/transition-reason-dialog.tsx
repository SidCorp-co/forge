// RFC 0002 INV-8 — the statuses that stop or end the work carry the reason they
// did (`issue-machine.ts:REASON_REQUIRED_STATUSES`: reopen, needs_info, on_hold, dropped).
// The server rejects the write without one (422 TRANSITION_REASON_REQUIRED, plus
// WAITING_KIND_REQUIRED for `needs_info`), so every surface that offers these
// routes through here rather than firing the mutation and surfacing a 422 toast.

import type { REASON_REQUIRED_STATUSES } from "@forge/contracts/issue-machine";
import { useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { IssueStatus, WaitingCause } from "../types";
import { endsTheIssue, MootQuestions, useMootQuestions } from "./moot-questions";

export type ReasonStatus = (typeof REASON_REQUIRED_STATUSES)[number];
/** ISS-1257 — a close the server refused because questions on the issue are still open. */
export type DialogMode = ReasonStatus | "void_questions";

interface CopySpec {
  title: string;
  confirm: string;
  placeholder: string;
}

const copyOf = (t: Copy, mode: DialogMode): CopySpec => ({
  title: t(`issues.reason.${mode}.title`),
  confirm: t(`issues.reason.${mode}.confirm`),
  placeholder: t(`issues.reason.${mode}.placeholder`),
});

const KIND_ORDER: WaitingCause[] = ["needs_answer", "needs_decision", "needs_resource"];
/** What each kind asks of the person, after the legend's own word for it. */
const kindLabel = (t: Copy, k: WaitingCause): string => `${t(`issues.waitingKind.${k}`)} — ${t(`issues.waitingKind.${k}.asks`)}`;

interface TransitionReasonDialogProps {
  status: DialogMode | null;
  /** The issue moved; with `moveTo`, whose open questions a close or drop shows (ISS-560). */
  issueId?: string;
  /** Where the move goes: the reason status itself, or the close a `void_questions` prompt held up. */
  moveTo?: IssueStatus;
  loading: boolean;
  /** The last refused move's error: a refusal that keeps the dialog open frees its confirm again. */
  failure?: unknown;
  onConfirm: (reason: string, waitingKind?: WaitingCause) => void;
  onClose: () => void;
}

export function TransitionReasonDialog(props: TransitionReasonDialogProps) {
  if (!props.status) return null;
  // each status asked for starts a fresh reason: the form remounts rather than being reset
  return <ReasonForm key={props.status} {...props} status={props.status} />;
}

function ReasonForm({
  status,
  issueId,
  moveTo,
  loading,
  failure,
  onConfirm,
  onClose,
}: TransitionReasonDialogProps & { status: DialogMode }) {
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<WaitingCause>("needs_answer");
  /** Set on the first confirm, so a second click before `loading` arrives sends no second move. */
  const [sent, setSent] = useState(false);
  const t = useCopy();

  // a move that settled (loading went false) frees the confirm again, and so does a refusal that
  // settled before a render saw it pending
  const [wasLoading, setWasLoading] = useState(loading);
  if (wasLoading !== loading) {
    setWasLoading(loading);
    if (!loading) setSent(false);
  }
  const [seenFailure, setSeenFailure] = useState(failure);
  if (seenFailure !== failure) {
    setSeenFailure(failure);
    if (failure) setSent(false);
  }

  const copy = copyOf(t, status);
  const trimmed = reason.trim();
  const asksKind = status === "needs_info";
  const shows = endsTheIssue(moveTo) && issueId ? issueId : null;
  const moot = useMootQuestions(shows);
  const ready = trimmed.length > 0 && !moot.loading;

  return (
    <SlideOver open onClose={onClose} title={copy.title} width={480}>
      <div className="flex h-full flex-col gap-4">
        {shows && <MootQuestions issueId={shows} />}
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
              onConfirm(trimmed, asksKind ? kind : undefined);
            }}
          >
            {copy.confirm}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
