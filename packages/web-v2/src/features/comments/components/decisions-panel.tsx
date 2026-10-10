"use client";

import type { DecisionMaker } from "@forge/contracts/comments";
import { WrittenMark } from "@/lib/i18n/written";
import { type ReactNode, useState } from "react";
import { ActorChip, BodyView, Button, Input, Textarea } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useEntityDecisions, usePostEntityComment } from "../hooks";
import type { DecisionReadScope, EntityCommentScope, EntityCommentView } from "../types";

function Line({ label, children }: { label: string; children: string }) {
  return (
    <p className="text-13 leading-relaxed text-muted">
      <span className="font-medium text-fg">{label}</span> {children}
    </p>
  );
}

/** One decision; `onTarget` names what it sits on when a list holds more than one target's. */
export function DecisionRow({ c, onTarget }: { c: EntityCommentView; onTarget?: ReactNode }) {
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
        {onTarget ? (
          <>
            <span aria-hidden>·</span>
            {onTarget}
          </>
        ) : null}
        {c.edited ? <span title={t("common.decisions.editedAt", { at: time.dateTime(c.updatedAt) })}>· {t("common.decisions.edited")}</span> : null}
      </span>
      {c.datedAhead ? (
        <p className="text-12 text-warn-11" data-testid="decision-dated-ahead">
          {t("decisions.datedAhead", { at: time.dateTime(c.datedAhead) })}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Under a decision list: how many records agents kept are folded away (a master's pass logs among
 * them), with the act that shows them, or, while they show, the act that folds them again.
 */
/** What agents kept folded and the switch to show it; `busy` while the switch's rows load, the button spinning and shut. */
export function FoldedDecisions({ by, folded, onBy, busy = false }: { by: DecisionMaker; folded: number; onBy: (by: DecisionMaker) => void; busy?: boolean }) {
  const t = useCopy();
  if (by === "people" && folded === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-13 text-muted" data-testid="decisions-folded">
      <span>{by === "people" ? t("decisions.folded", { n: folded }) : t("decisions.showingAll")}</span>
      <Button size="sm" variant="ghost" loading={busy} onClick={() => onBy(by === "people" ? "all" : "people")}>
        {by === "people" ? t("decisions.showAgents") : t("decisions.onlyPeople")}
      </Button>
    </p>
  );
}

export function DecisionComposer({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
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
      <RefusalLine error={post.error} testid="decision-refusal" />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!ready}>
          {t("common.decisions.submit")}
        </Button>
      </span>
    </form>
  );
}

/**
 * The decisions recorded on one item, oldest first, through the one entity decisions read. A
 * requirement, workflow or feedback item records one here; an issue records one in its thread.
 */
export function DecisionsPanel({ projectId, scope, targetRef }: { projectId: string; scope: DecisionReadScope; targetRef: string }) {
  const q = useEntityDecisions(projectId, scope, targetRef);
  const t = useCopy();
  return (
    <QueryBoundary query={q} loadingLabel={t("common.decisions.loading")} height="inline">
      {(data) => (
        <div className="grid gap-4" data-testid="decisions-panel">
          {data.comments.length ? (
            <ul className="grid">
              {[...data.comments].reverse().map((c) => (
                <DecisionRow key={c.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="text-13 text-subtle">{t("common.decisions.none")}</p>
          )}
          {scope === "issue" ? null : <DecisionComposer projectId={projectId} scope={scope} targetRef={targetRef} />}
        </div>
      )}
    </QueryBoundary>
  );
}
