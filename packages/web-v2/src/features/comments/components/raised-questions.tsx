// The questions people raised as comments on one item (intent `question`), read on that item: a
// feedback item or a workflow has no comment thread of its own, so a question raised there — through
// the old Questions desk or any door — is drawn here (REQ-33 BC-8). A question is owed until somebody
// other than its asker replies under it; then that first reply is its answer. Newest first, flat.

import { BodyView, StatusBadge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useEntityComments } from "../hooks";
import type { EntityCommentScope, EntityCommentView } from "../types";

export interface RaisedQuestion {
  question: EntityCommentView;
  answer: EntityCommentView | null;
}

/** Each top-level question with the first reply by someone other than its asker, newest question first. */
export function raisedQuestionsOf(comments: readonly EntityCommentView[]): RaisedQuestion[] {
  const byTime = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byTime
    .filter((c) => c.intent === "question" && c.parentId === null)
    .map((question) => ({ question, answer: byTime.find((r) => r.parentId === question.id && r.author.id !== question.author.id) ?? null }))
    .reverse();
}

/** The raised questions on one item, read from its comments. */
export function useRaisedQuestions(projectId: string, scope: EntityCommentScope, targetRef: string): RaisedQuestion[] {
  const q = useEntityComments(projectId, scope, targetRef);
  return raisedQuestionsOf(q.data?.comments ?? []);
}

/** The raised questions as flat rows, for a section that heads them itself; `joined` continues a list drawn just above, under its hairline. */
export function RaisedQuestionList({ raised, joined = false }: { raised: readonly RaisedQuestion[]; joined?: boolean }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <ul className={cn("m-0 grid list-none divide-y divide-line-subtle border-b border-line-subtle p-0", !joined && "border-t")} data-testid="raised-questions">
      {raised.map(({ question, answer }) => (
        <li key={question.id} className="grid gap-1 py-2.5" data-testid="raised-question" data-state={answer ? "answered" : "owed"}>
          <span className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 break-words">
              {question.body ? <BodyView body={question.body} format={question.format} className="text-fg" /> : <span className="text-13 text-subtle">{t("common.questions.withheld")}</span>}
            </span>
            <StatusBadge family="question" value={answer ? "answered" : "open"} />
          </span>
          <span className="text-12 text-muted">
            {t("common.questions.askedBy", { who: question.author.name ?? t("common.questions.someone") })} · {time.relative(question.createdAt)}
          </span>
          {answer ? (
            <span className="grid gap-0.5 border-l-2 border-line pl-3" data-testid="raised-answer">
              {answer.body ? <BodyView body={answer.body} format={answer.format} className="text-fg" /> : <span className="text-13 text-subtle">{t("common.questions.withheld")}</span>}
              <span className="text-12 text-muted">
                {answer.author.name ?? t("common.questions.someone")} · {time.relative(answer.createdAt)}
              </span>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** An item's raised questions under their own heading, or nothing where nobody raised one. */
export function RaisedQuestions({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const t = useCopy();
  const raised = useRaisedQuestions(projectId, scope, targetRef);
  if (raised.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="raised-questions-section">
      <h3 className="text-14 font-semibold leading-snug text-fg">
        {t("common.questions.raised")} <span className="font-normal text-muted">· {raised.length}</span>
      </h3>
      <RaisedQuestionList raised={raised} />
    </section>
  );
}
