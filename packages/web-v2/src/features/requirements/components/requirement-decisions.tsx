"use client";

// A requirement's Decisions tab (JU-5): the decisions a person recorded on it and on the issues that
// deliver it, newest first, each naming what it sits on, with what agents kept folded away and
// counted; then the answers its questions and its issues' questions took. Both stay folded until
// opened (REQ-35 BC-7). Core rolls both up; the composer records a decision on the requirement itself.

import { Disclosure, ErrorState, ProjectLoader } from "@/design";
import { DecisionComposer, Decision, FoldedDecisions } from "@/features/comments";
import { DecisionTarget } from "@/features/comments";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { DecisionMaker } from "@forge/contracts/comments";
import type { RequirementAnswerView } from "@forge/contracts/requirements";
import { useState } from "react";
import { useRequirementDecisions } from "../hooks";

function RecordedAnswer({ a, slug }: { a: RequirementAnswerView; slug: string }) {
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
            <DecisionTarget slug={slug} target={{ scope: "issue", key: a.place.key, title: a.place.title }} />
          </>
        ) : null}
      </span>
    </li>
  );
}

export function RequirementDecisions({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const t = useCopy();
  const [by, setBy] = useState<DecisionMaker>("people");
  const q = useRequirementDecisions(projectId, reqKey, by);
  if (q.isLoading) return <ProjectLoader label={t("common.decisions.loading")} />;
  if (q.isError || !q.data) {
    return <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => void q.refetch() : undefined} />;
  }
  const { decisions, answers } = q.data;
  // the rows shown while a switch of whose decisions show loads are this requirement's previous ones
  const busy = q.isPlaceholderData;
  return (
    <div data-testid="requirement-decisions">
      <Disclosure title={t("requirements.tab.decisions")} count={decisions.length}>
        {decisions.length ? (
          <ul className={busy ? "grid opacity-60" : "grid"} aria-busy={busy || undefined} data-testid="decision-rows">
            {decisions.map((c) => (
              <Decision key={c.id} c={c} onTarget={c.target.key === reqKey ? undefined : <DecisionTarget slug={slug} target={c.target} />} />
            ))}
          </ul>
        ) : (
          <p className="text-13 text-subtle">{t("common.decisions.none")}</p>
        )}
        <div className="mt-2">
          <FoldedDecisions by={q.data.by} folded={q.data.folded} onBy={setBy} busy={busy} />
        </div>
      </Disclosure>
      <div className="-mt-px">
        <Disclosure title={t("requirements.decisions.answers")} count={answers.length}>
          {answers.length ? (
            <ul className="grid">
              {answers.map((a) => (
                <RecordedAnswer key={a.questionId} a={a} slug={slug} />
              ))}
            </ul>
          ) : (
            <p className="text-13 text-subtle">{t("requirements.decisions.noAnswers")}</p>
          )}
        </Disclosure>
      </div>
      <div className="mt-4">
        <DecisionComposer projectId={projectId} scope="requirement" targetRef={reqKey} />
      </div>
    </div>
  );
}
