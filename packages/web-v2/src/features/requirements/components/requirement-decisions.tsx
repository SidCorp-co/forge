"use client";

// A requirement's Decisions tab (JU-5): the decisions recorded on it and on the issues that deliver
// it, newest first, each naming what it sits on, then the answers its questions and its issues'
// questions took. Core rolls both up; the composer records a decision on the requirement itself.

import { ErrorState, ProjectLoader, ViewHeading } from "@/design";
import { DecisionComposer, DecisionRow } from "@/features/comments/components/decisions-panel";
import { DecisionTarget } from "@/features/comments/components/decision-target";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { RequirementAnswerView } from "@forge/contracts/requirements";
import Link from "next/link";
import { issueHref } from "@/lib/routes/issues";
import { useRequirementDecisions } from "../hooks";

function AnswerRow({ a, slug }: { a: RequirementAnswerView; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <li className="grid gap-1 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="requirement-answer">
      <p className="text-13 text-muted">{a.prompt}</p>
      <p className="text-14 font-medium leading-snug text-fg">{a.answer}</p>
      <span className="flex flex-wrap items-center gap-2 text-12 text-subtle">
        <span>{a.answeredBy ?? t("requirements.unknown")}</span>
        <span aria-hidden>·</span>
        <span title={time.dateTime(a.answeredAt)}>{time.relative(a.answeredAt)}</span>
        {a.place.kind === "issue" ? (
          <>
            <span aria-hidden>·</span>
            <Link href={issueHref(slug, a.place.key)} className="font-mono text-12 font-semibold text-link hover:underline" title={a.place.title}>
              {a.place.key}
            </Link>
          </>
        ) : null}
      </span>
    </li>
  );
}

export function RequirementDecisions({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const t = useCopy();
  const q = useRequirementDecisions(projectId, reqKey);
  if (q.isLoading) return <ProjectLoader label={t("common.decisions.loading")} />;
  if (q.isError || !q.data) {
    return <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />;
  }
  const { decisions, answers } = q.data;
  return (
    <div className="grid gap-8" data-testid="requirement-decisions">
      <section>
        <ViewHeading hint={t("requirements.decisions.rollupHint")}>{t("requirements.tab.decisions")}</ViewHeading>
        {decisions.length ? (
          <ul className="grid">
            {decisions.map((c) => (
              <DecisionRow key={c.id} c={c} onTarget={c.target.key === reqKey ? undefined : <DecisionTarget slug={slug} target={c.target} />} />
            ))}
          </ul>
        ) : (
          <p className="text-13 text-subtle">{t("common.decisions.none")}</p>
        )}
        <div className="mt-4">
          <DecisionComposer projectId={projectId} scope="requirement" targetRef={reqKey} />
        </div>
      </section>
      <section>
        <ViewHeading>{t("requirements.decisions.answers")}</ViewHeading>
        {answers.length ? (
          <ul className="grid">
            {answers.map((a) => (
              <AnswerRow key={a.questionId} a={a} slug={slug} />
            ))}
          </ul>
        ) : (
          <p className="text-13 text-subtle">{t("requirements.decisions.noAnswers")}</p>
        )}
      </section>
    </div>
  );
}
