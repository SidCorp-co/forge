"use client";

// The decisions only the viewer can make (REQ-41 BC-1, BC-2), as core's needs-me read answers them:
// each with its question, the recommended answer and why, and the buttons that answer it. A button
// posts its own body to the route the record's page calls, as the person who presses it (BC-9);
// nothing is decided here. Flat rows under hairlines, one heading per group; the project home and
// the chat draw the same list.

import {
  type DecisionAnswer,
  NEEDS_YOU_DECISION_GROUP_LABELS,
  NEEDS_YOU_DECISION_GROUPS,
  type NeedsYouDecision,
  type NeedsYouDecisions,
} from "@forge/contracts/needs-you-decisions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button, Icon, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { needsYouApi } from "../api";
import { NEEDS_YOU_ROOT } from "../hooks";

/** The page a decision opens on, or null where no record holds it. */
export function decisionHref(slug: string, opens: NeedsYouDecision["opens"]): string | null {
  if (!opens) return null;
  switch (opens.kind) {
    case "issue":
      return issueHref(slug, opens.key);
    case "requirement":
      return requirementHref(slug, opens.key);
    case "feedback":
      return feedbackHref(slug, opens.key);
    case "workflow":
      return workflowHref(slug, opens.key);
    case "release":
      return releaseHref(slug, opens.key);
  }
}

/**
 * The body a button posts: its own, and what the person typed under the field its route reads, the
 * answer's `text` for a question and the `reason` for every other act that takes one.
 */
export function pressBody(answer: DecisionAnswer, typed: string | null): Record<string, unknown> {
  const body = { ...(answer.body ?? {}) };
  if (answer.needsReason) body[answer.act === "question.answer" ? "text" : "reason"] = typed ?? "";
  return body;
}

function DecisionRow({ d, slug }: { d: NeedsYouDecision; slug: string | undefined }) {
  const t = useCopy();
  const qc = useQueryClient();
  const [typing, setTyping] = useState<DecisionAnswer | null>(null);
  const [typed, setTyped] = useState("");
  const press = useMutation({
    mutationFn: ({ answer, text }: { answer: DecisionAnswer; text: string | null }) =>
      needsYouApi.press(answer.path, pressBody(answer, text)),
    onSuccess: () => {
      setTyping(null);
      qc.invalidateQueries({ queryKey: NEEDS_YOU_ROOT });
    },
  });
  const href = slug ? decisionHref(slug, d.opens) : null;
  const recommended = d.recommended ? d.answers.find((a) => a.id === d.recommended?.answerId) : undefined;
  const sent = press.isSuccess ? press.variables?.answer : undefined;
  return (
    <li className="flex flex-col gap-1.5 py-3" data-testid="needs-you-decision" data-group={d.group} data-key={d.key}>
      <p className="fg-caption text-muted">
        {href ? (
          <Link href={href} className="font-mono text-fg underline-offset-2 hover:underline">
            {d.opens?.key ?? d.key}
          </Link>
        ) : (
          <span className="font-mono text-fg">{d.opens?.key ?? d.key}</span>
        )}
        {d.title && <span> · {d.title}</span>}
      </p>
      <p className="fg-body-sm whitespace-pre-wrap text-fg" data-testid="needs-you-decision-question">
        {d.question}
      </p>
      {d.recommended && recommended ? (
        <p className="fg-caption text-muted" data-testid="needs-you-decision-recommended">
          <span className="font-semibold text-fg">{t("needsYou.decisions.recommended")}:</span> {recommended.label}. {d.recommended.why}
        </p>
      ) : (
        <p className="fg-caption text-subtle" data-testid="needs-you-decision-no-recommendation">
          {t("needsYou.decisions.noRecommendation")}: {d.noRecommendation}
        </p>
      )}
      {sent ? (
        <p className="fg-caption flex items-center gap-1 text-fg" role="status">
          <Icon name="check" size={12} />
          {t("needsYou.decisions.sent", { label: sent.label })}
        </p>
      ) : typing ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) press.mutate({ answer: typing, text: typed.trim() });
          }}
        >
          <label className="fg-caption text-muted" htmlFor={`decision-${d.key}-${typing.id}`}>
            {t(typing.act === "question.answer" ? "needsYou.decisions.answerLabel" : "needsYou.decisions.reasonLabel")}
          </label>
          <Textarea
            id={`decision-${d.key}-${typing.id}`}
            rows={2}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="needs-you-decision-typed"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" type="submit" loading={press.isPending} disabled={!typed.trim()}>
              {t("needsYou.decisions.send")}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setTyping(null)}>
              {t("needsYou.decisions.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {d.answers.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={a.recommended ? "primary" : "secondary"}
              title={a.effect ?? undefined}
              loading={press.isPending && press.variables?.answer.id === a.id}
              data-testid="needs-you-decision-answer"
              data-answer={a.id}
              onClick={() => {
                if (a.needsReason) {
                  setTyped("");
                  setTyping(a);
                } else press.mutate({ answer: a, text: null });
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {press.isError && (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(press.error)}
        </p>
      )}
    </li>
  );
}

/** The decisions, one heading per group in the contract's order, and one line naming what was left out. */
export function DecisionList({ read, slug }: { read: NeedsYouDecisions; slug?: string | undefined }) {
  const t = useCopy();
  const groups = NEEDS_YOU_DECISION_GROUPS.map((g) => ({ g, rows: read.decisions.filter((d) => d.group === g) })).filter(
    (x) => x.rows.length > 0,
  );
  const leftOut = read.notDecisions.map((n) => t(`needsYou.decisions.reason.${n.reason}`, { n: n.count }));
  return (
    <section aria-label={t("needsYou.decisions.aria")} className="flex flex-col gap-3" data-testid="needs-you-decisions">
      {groups.length === 0 && <p className="fg-body-sm text-muted">{t("needsYou.decisions.none")}</p>}
      {groups.map(({ g, rows }) => (
        <div key={g}>
          <h3 className="fg-caption border-b border-line pb-1 font-semibold text-fg">
            {NEEDS_YOU_DECISION_GROUP_LABELS[g]} <span className="font-normal text-muted">· {rows.length}</span>
          </h3>
          <ul className="flex flex-col divide-y divide-line-subtle">
            {rows.map((d) => (
              <DecisionRow key={`${d.group}:${d.key}`} d={d} slug={slug} />
            ))}
          </ul>
        </div>
      ))}
      {read.total > read.decisions.length && (
        <p className="fg-caption text-subtle">{t("needsYou.decisions.more", { shown: read.decisions.length, total: read.total })}</p>
      )}
      {leftOut.length > 0 && (
        <p className="fg-caption text-subtle" data-testid="needs-you-left-out">
          {t("needsYou.decisions.leftOut", { list: leftOut.join(", ") })}
        </p>
      )}
    </section>
  );
}
