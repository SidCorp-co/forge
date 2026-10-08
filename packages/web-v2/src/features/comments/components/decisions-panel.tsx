"use client";

import { WrittenMark } from "@/lib/i18n/written";
import { useState } from "react";
import { ActorChip, BodyView, Button, ErrorState, Input, ProjectLoader, Textarea } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useEntityDecisions, usePostEntityComment } from "../hooks";
import type { EntityCommentScope, EntityCommentView } from "../types";

function Line({ label, children }: { label: string; children: string }) {
  return (
    <p className="text-13 leading-relaxed text-muted">
      <span className="font-medium text-fg">{label}</span> {children}
    </p>
  );
}

function DecisionRow({ c }: { c: EntityCommentView }) {
  const d = c.decision;
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <li className="grid gap-1.5 border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0" data-testid="decision-row" lang={c.writtenLang ?? undefined}>
      {d ? (
        <>
          <p className="text-14 font-medium leading-snug text-fg">{d.decision}</p>
          <Line label={t("common.decisions.why")}>{d.reason}</Line>
          {d.options?.length ? <Line label={t("common.decisions.options")}>{d.options.join("; ")}</Line> : null}
          {d.authority ? <Line label={t("common.decisions.authority")}>{d.authority}</Line> : null}
          {d.reversedWhen ? <Line label={t("common.decisions.reversedWhen")}>{d.reversedWhen}</Line> : null}
        </>
      ) : c.body ? (
        <BodyView body={c.body} format={c.format} className="text-14" />
      ) : (
        <p className="text-13 text-subtle">{t("common.decisions.withheld")}</p>
      )}
      <span className="mt-0.5 inline-flex items-center gap-2 text-12 text-subtle">
        <ActorChip name={c.author.name ?? t("common.decisions.unknownAuthor")} kind={c.author.agency} size={16} />
        <span aria-hidden>·</span>
        <span title={time.dateTime(c.createdAt)}>{time.relative(c.createdAt)}</span>
        <WrittenMark lang={c.writtenLang} />
        {c.edited ? <span title={t("common.decisions.editedAt", { at: time.dateTime(c.updatedAt) })}>· {t("common.decisions.edited")}</span> : null}
      </span>
    </li>
  );
}

function DecisionComposer({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const post = usePostEntityComment(projectId, scope, targetRef);
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const [options, setOptions] = useState("");
  const [authority, setAuthority] = useState("");
  const [reversedWhen, setReversedWhen] = useState("");
  const ready = decision.trim().length > 0 && reason.trim().length > 0;
  const t = useCopy();
  const submit = () => {
    const listed = options.split(";").map((o) => o.trim()).filter(Boolean);
    post.mutate(
      {
        intent: "decision",
        decision: {
          decision: decision.trim(),
          reason: reason.trim(),
          ...(listed.length ? { options: listed } : {}),
          ...(authority.trim() ? { authority: authority.trim() } : {}),
          ...(reversedWhen.trim() ? { reversedWhen: reversedWhen.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          for (const reset of [setDecision, setReason, setOptions, setAuthority, setReversedWhen]) reset("");
        },
      },
    );
  };
  return (
    <form
      className="grid gap-2 border-t border-line-subtle pt-4"
      data-testid="decision-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit();
      }}
    >
      <p className="text-13 font-medium text-fg">{t("common.decisions.record")}</p>
      <Textarea aria-label={t("common.decisions.decision")} placeholder={t("common.decisions.decisionPlaceholder")} rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} />
      <Textarea aria-label={t("common.decisions.reason")} placeholder={t("common.decisions.reasonPlaceholder")} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Input aria-label={t("common.decisions.optionsLabel")} placeholder={t("common.decisions.optionsPlaceholder")} value={options} onChange={(e) => setOptions(e.target.value)} />
      <Input aria-label={t("common.decisions.authorityLabel")} placeholder={t("common.decisions.authorityPlaceholder")} value={authority} onChange={(e) => setAuthority(e.target.value)} />
      <Input aria-label={t("common.decisions.reversedLabel")} placeholder={t("common.decisions.reversedLabel")} value={reversedWhen} onChange={(e) => setReversedWhen(e.target.value)} />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!ready || post.isPending}>
          {t("common.decisions.submit")}
        </Button>
        {post.isError ? <span className="text-12 text-red">{formatApiError(post.error)}</span> : null}
      </span>
    </form>
  );
}

export function DecisionsPanel({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const q = useEntityDecisions(projectId, scope, targetRef);
  const t = useCopy();
  if (q.isLoading) return <ProjectLoader label={t("common.decisions.loading")} />;
  if (q.isError || !q.data) {
    return <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />;
  }
  const rows = [...q.data.comments].reverse();
  return (
    <div className="grid gap-4" data-testid="decisions-panel">
      {rows.length ? (
        <ul className="grid">
          {rows.map((c) => (
            <DecisionRow key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-13 text-subtle">{t("common.decisions.none")}</p>
      )}
      <DecisionComposer projectId={projectId} scope={scope} targetRef={targetRef} />
    </div>
  );
}
