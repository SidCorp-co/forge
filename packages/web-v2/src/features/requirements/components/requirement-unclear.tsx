"use client";

// What a requirement still leaves unclear (JU-6): the questions standing on it, open first, each with
// who answers it and whether the agree waits for it, and the assumptions its revision takes as true.
// Flat rows under hairline dividers; the counts and the blocking flag are core's.

import { useState } from "react";
import { Button, Textarea, ToneBadge, ViewHeading } from "@/design";
import { DecisionTarget } from "@/features/comments/components/decision-target";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { RequirementAssumption, RequirementQuestionPlace, RequirementQuestionView } from "@forge/contracts/requirements";
import { useAnswerRequirementQuestion } from "../hooks";

function Place({ place, slug }: { place: RequirementQuestionPlace; slug: string }) {
  const t = useCopy();
  if (place.kind === "issue") {
    return (
      <span>
        {t("requirements.unclear.askedOn")}{" "}
        <DecisionTarget slug={slug} target={{ scope: "issue", key: place.key, title: place.title }} />
      </span>
    );
  }
  return <span>{t(place.kind === "run" ? "requirements.unclear.askedByRun" : "requirements.unclear.askedHere")}</span>;
}

function AnswerForm({ q, projectId, reqKey }: { q: RequirementQuestionView; projectId: string; reqKey: string }) {
  const t = useCopy();
  const answer = useAnswerRequirementQuestion(projectId, reqKey);
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  return (
    <form
      className="mt-2 grid max-w-[72ch] gap-2"
      data-testid="unclear-answer"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) answer.mutate({ questionId: q.id, round: q.round, text: text.trim() }, { onSuccess: () => setText("") });
      }}
    >
      <Textarea aria-label={t("requirements.unclear.answerLabel")} placeholder={t("requirements.unclear.answerPlaceholder")} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="secondary" disabled={!ready || answer.isPending}>
          {t("requirements.unclear.answer")}
        </Button>
        <span className="text-12 text-subtle">{t("requirements.unclear.becomesDecision")}</span>
      </span>
      <RefusalLine error={answer.error} testid="unclear-answer-refusal" />
    </form>
  );
}

function QuestionRow({ q, projectId, reqKey, slug }: { q: RequirementQuestionView; projectId: string; reqKey: string; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const open = q.status === "open";
  return (
    <li className="grid gap-1 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="unclear-question" data-status={q.status}>
      <p className={`text-14 leading-snug ${open ? "font-medium text-fg" : "text-muted"}`}>{q.prompt}</p>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-subtle">
        {open && q.blocking ? <ToneBadge tone="you" label={t("requirements.unclear.blocksAgree")} title={t("requirements.unclear.blocksAgreeHint")} /> : null}
        {q.whoAnswers ? <span>{t("requirements.unclear.whoAnswers", { who: q.whoAnswers })}</span> : null}
        {q.whoAnswers ? <span aria-hidden>·</span> : null}
        <Place place={q.place} slug={slug} />
        <span aria-hidden>·</span>
        <span title={time.dateTime(q.askedAt)}>{time.relative(q.askedAt)}</span>
      </span>
      {q.answer ? (
        <p className="max-w-[80ch] text-13 leading-relaxed text-fg" data-testid="unclear-answered">
          <span className="font-medium">{t("requirements.unclear.answered")}</span> {q.answer.text}
          <span className="text-12 text-subtle">
            {" "}
            · {q.answer.by ?? t("requirements.unknown")} · <span title={time.dateTime(q.answer.at)}>{time.relative(q.answer.at)}</span>
          </span>
        </p>
      ) : null}
      {open && q.place.kind === "requirement" ? <AnswerForm q={q} projectId={projectId} reqKey={reqKey} /> : null}
    </li>
  );
}

/** "Still unclear · n": the questions standing on the requirement, open ones first. */
export function UnclearSection({
  questions,
  unclear,
  projectId,
  reqKey,
  slug,
}: {
  questions: RequirementQuestionView[];
  unclear: number;
  projectId: string;
  reqKey: string;
  slug: string;
}) {
  const t = useCopy();
  return (
    <section data-testid="requirement-unclear">
      <ViewHeading hint={t("requirements.unclear.count", { n: unclear })}>{t("requirements.unclear.heading")}</ViewHeading>
      {questions.length === 0 ? (
        <p className="text-13 text-subtle">{t("requirements.unclear.none")}</p>
      ) : (
        <ul className="grid">
          {questions.map((q) => (
            <QuestionRow key={q.id} q={q} projectId={projectId} reqKey={reqKey} slug={slug} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** What the revision takes as true without proof: each with whose it is and how it will be confirmed. */
export function AssumptionsSection({ assumptions, revision }: { assumptions: RequirementAssumption[]; revision: number | null }) {
  const t = useCopy();
  return (
    <section data-testid="requirement-assumptions">
      <ViewHeading hint={revision !== null ? t("requirements.overview.fromR", { r: revision }) : undefined}>{t("requirements.assumptions.heading")}</ViewHeading>
      {assumptions.length === 0 ? (
        <p className="text-13 text-subtle">{t("requirements.assumptions.none")}</p>
      ) : (
        <ul className="grid">
          {assumptions.map((a) => (
            <li key={a.text} className="grid gap-1 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="assumption">
              <p className="text-14 leading-snug text-fg">{a.text}</p>
              <span className="text-12 text-subtle">
                {t("requirements.assumptions.owner", { who: a.owner })} · {t("requirements.assumptions.confirmBy", { how: a.confirmBy })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
