// A decision record in an issue's history, and its withdrawal (ISS-585, REQ-33 BC-2): the decision
// reads as its own words; a withdrawn one keeps its line, marked, beside the withdrawal and its reason.
// Its writer, or a project admin, withdraws it here with a reason.

import { useState } from "react";
import { Badge, Button, Field, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useWithdrawDecision } from "../detail-hooks";
import type { ActivityItem } from "../types";

export const DECISION_ACTION = "record.decision";
export const WITHDRAWAL_ACTION = "record.withdrawal";

type Field = { key: string; value: string };

const isField = (f: unknown): f is Field =>
  typeof f === "object" &&
  f !== null &&
  typeof (f as Partial<Field>).key === "string" &&
  typeof (f as Partial<Field>).value === "string";

function fieldsOf(item: ActivityItem): Field[] {
  const raw: unknown = item.payload?.fields;
  return Array.isArray(raw) ? raw.filter(isField) : [];
}

const valueOf = (item: ActivityItem, key: string) => fieldsOf(item).find((f) => f.key === key)?.value ?? null;

/** What a decision record decided, in its writer's words. */
export function decisionWords(item: ActivityItem): string {
  return valueOf(item, "decision") ?? valueOf(item, "lead") ?? fieldsOf(item)[0]?.value ?? "";
}

/** The reason a withdrawal gives. */
export function withdrawalReason(item: ActivityItem): string {
  return valueOf(item, "reason") ?? "";
}

/** Each withdrawn decision's id, named by a withdrawal among these rows. */
export function withdrawnIds(items: readonly ActivityItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const named = item.action === WITHDRAWAL_ACTION ? item.payload?.withdraws : undefined;
    if (typeof named === "string") out.add(named);
  }
  return out;
}

export interface DecisionWithdraw {
  issueId: string;
  /** Whether this reader may withdraw this decision: its writer, or a project admin. */
  may: (item: ActivityItem) => boolean;
}

export function DecisionLine({
  item,
  withdrawn,
  withdraw,
}: {
  item: ActivityItem;
  withdrawn: boolean;
  withdraw: DecisionWithdraw | undefined;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const words = decisionWords(item);
  const offered = !withdrawn && !!withdraw && withdraw.may(item);
  return (
    <span className="grid gap-1.5" data-testid="activity-decision">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge tone={withdrawn ? "neutral" : "green"}>{t("common.decisions.decision")}</Badge>
        <span className={withdrawn ? "text-muted line-through" : undefined}>{words}</span>
        {withdrawn ? <Badge tone="neutral">{t("issues.activity.withdrawn")}</Badge> : null}
        {offered && !open ? (
          <button type="button" className="fg-caption hover:text-fg" onClick={() => setOpen(true)}>
            {t("issues.activity.withdraw")}
          </button>
        ) : null}
      </span>
      {offered && open && withdraw ? (
        <WithdrawForm issueId={withdraw.issueId} eventId={item.id} onDone={() => setOpen(false)} />
      ) : null}
    </span>
  );
}

function WithdrawForm({ issueId, eventId, onDone }: { issueId: string; eventId: string; onDone: () => void }) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const withdraw = useWithdrawDecision(issueId);
  const ready = reason.trim().length > 0;
  return (
    <span className="grid gap-2" data-testid="withdraw-decision">
      <Field label={t("common.decisions.reason")}>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={600} disabled={withdraw.isPending} />
      </Field>
      <RefusalLine error={withdraw.error} testid="withdraw-refusal" />
      <span className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={withdraw.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={withdraw.isPending}
          disabled={!ready}
          onClick={() => withdraw.mutate({ eventId, reason: reason.trim() }, { onSuccess: onDone })}
        >
          {t("issues.activity.withdrawConfirm")}
        </Button>
      </span>
    </span>
  );
}

export function WithdrawalLine({ item }: { item: ActivityItem }) {
  const t = useCopy();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="activity-withdrawal">
      {t("issues.activity.decisionWithdrawn")}
      <span className="text-muted">{withdrawalReason(item)}</span>
    </span>
  );
}
