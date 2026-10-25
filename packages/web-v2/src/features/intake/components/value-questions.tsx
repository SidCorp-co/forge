// The questions of an item's draft (REQ-65 BC-3, BC-5; REQ-34 BC-14..BC-16): at most three, each a row
// of chips with the recommended one marked. A person answers by picking one. A question that holds the
// check says what it blocks on; any other question has its recommended answer taken until it is answered.
// Questions answered on an earlier draft stay listed as asked and answered.

import { ChoiceChips, FieldLabel, ToneBadge } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAnswerIntakeQuestion } from "../hooks";
import type { IntakeDraftView, IntakeQuestionView } from "../types";

function Question({ q, projectId, itemKey, can }: { q: IntakeQuestionView; projectId: string; itemKey: string; can: boolean }) {
  const t = useCopy();
  const answer = useAnswerIntakeQuestion(projectId, itemKey);
  const picked = q.answer?.option ?? null;
  const shownOption = q.options.find((o) => o.id === (picked ?? q.recommended));
  const recommendedMark = <span className="text-11-5 font-semibold text-accent-text">{t("intake.recommended")}</span>;
  return (
    <li className="grid gap-2 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="intake-question" data-blocks={q.blocks ?? undefined}>
      <p className="text-14 leading-snug text-fg">
        {q.prompt} <span className="text-12 text-subtle">· {t(q.changes === "scope" ? "intake.changes.scope" : "intake.changes.outcome")}</span>
      </p>
      {q.blocks ? (
        <span>
          <ToneBadge tone="you" label={t(`intake.questions.blocks.${q.blocks}`)} title={t(`intake.questions.blocks.${q.blocks}`)} />
        </span>
      ) : null}
      {can ? (
        <ChoiceChips
          label={t("intake.questions.answerLabel", { n: q.number })}
          value={picked ? [picked] : []}
          onChange={(next) => {
            const option = next[0];
            if (option && option !== picked) answer.mutate({ question: q.number, option });
          }}
          options={q.options.map((o) => ({ value: o.id, label: o.label, mark: o.id === q.recommended ? recommendedMark : undefined }))}
        />
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <li
              key={o.id}
              className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-12 font-medium text-fg ${o.id === picked ? "border-link bg-sel" : "border-line"}`}
              data-testid="intake-option"
              data-recommended={o.id === q.recommended || undefined}
              data-picked={o.id === picked || undefined}
            >
              {o.label}
              {o.id === q.recommended ? recommendedMark : null}
            </li>
          ))}
        </ul>
      )}
      {shownOption ? (
        <p className="text-12 leading-snug text-subtle" data-testid="intake-question-state">
          {q.answer
            ? t("intake.questions.answeredBy", { who: q.answer.by.name ?? t("intake.someone") })
            : q.blocks
              ? t("intake.questions.waiting")
              : t("intake.questions.assumed")}
          {" · "}
          {shownOption.effect}
        </p>
      ) : null}
      <RefusalLine error={answer.error} testid="intake-answer-refusal" />
    </li>
  );
}

/** The draft's questions, or that it has nothing to ask, then what was answered before it. */
export function ValueQuestions({ draft, projectId }: { draft: IntakeDraftView; projectId: string }) {
  const t = useCopy();
  return (
    <div data-testid="intake-questions">
      <FieldLabel>{t("intake.questions")}</FieldLabel>
      {draft.questions.length === 0 ? (
        <p className="text-13 leading-snug" data-testid="intake-nothing-to-ask">
          <span className="font-medium text-fg">{t("intake.nothingToAsk")}</span>
          {draft.nothingToAsk ? <span className="text-subtle"> · {draft.nothingToAsk}</span> : null}
        </p>
      ) : (
        <ul className="grid">
          {draft.questions.map((q) => (
            <Question key={q.number} q={q} projectId={projectId} itemKey={draft.item.key} can={draft.can.answer} />
          ))}
        </ul>
      )}
      {draft.answered.length > 0 ? (
        <ul className="mt-3 grid gap-1">
          {draft.answered.map((a) => (
            <li key={`${a.prompt} ${a.at}`} className="text-13 leading-snug" data-testid="intake-answered">
              <span className="text-muted">{a.prompt}</span> <span className="font-medium text-fg">→ {a.label}</span>
              <span className="text-12 text-subtle"> · {a.by.name ?? t("intake.someone")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
