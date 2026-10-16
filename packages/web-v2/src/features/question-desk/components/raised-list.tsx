// The questions raised on the project, as core reads them (`GET …/raised-questions`): owed first, the
// longest waiting at the top, each naming who owes the reply; then the answered ones with the first
// answer and who gave it; then the closed ones, unanswered on an issue that has ended. Each is its
// short form, one line, never its body: the whole text stays on the record it was asked on. The
// answered and closed ones are a count, folded, read a page at a time once a reader opens them.

import type { RaisedQuestionAsker, RaisedQuestionOwer, RaisedQuestionState, RaisedQuestionView } from "@forge/contracts/comments";
import { useState } from "react";
import { Button, Icon, type LegendTone, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { Link } from "@/lib/navigation/router";
import { ActorChip, ToneBadge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { useRaisedGroup } from "../hooks";

const OWED_BY: Record<RaisedQuestionOwer, ProductCopyKey> = {
  agent: "questionDesk.owedBy.agent",
  members: "questionDesk.owedBy.members",
};

const STATE: Record<RaisedQuestionState, { label: ProductCopyKey; tone: LegendTone }> = {
  owed: { label: "questionDesk.owed", tone: "you" },
  answered: { label: "questionDesk.answered", tone: "done" },
  closed: { label: "questionDesk.closed", tone: "neutral" },
};

function hrefOf(slug: string, target: RaisedQuestionView["target"]): string {
  switch (target.scope) {
    case "issue":
      return issueHref(slug, target.key);
    case "requirement":
      return requirementHref(slug, target.key);
    case "feedback":
      return feedbackHref(slug, target.key);
    case "workflow":
      return workflowHref(slug, target.key);
  }
}

function RaisedQuestion({ q, slug, showAsker }: { q: RaisedQuestionView; slug: string; showAsker: boolean }) {
  const t = useCopy();
  const time = useTimeFormat();
  const state = STATE[q.state];
  const label = t(state.label);
  return (
    <li className="grid gap-1.5 py-3" data-testid="raised-question" data-state={q.state} data-id={q.id}>
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-12 text-muted">
        <ToneBadge tone={state.tone} label={label} title={label} value={q.state} />
        <Link href={hrefOf(slug, q.target)} className="font-mono font-semibold text-link hover:underline">
          {q.target.key}
        </Link>
        {q.target.title ? <span className="min-w-0 truncate">{q.target.title}</span> : null}
        <span title={time.dateTime(q.askedAt)}>· {time.relative(q.askedAt)}</span>
        {showAsker ? <ActorChip name={q.author.name ?? t("questionDesk.someone")} kind={q.author.agency} size={16} /> : null}
      </p>
      <p className="min-w-0 break-words text-14 text-fg" data-testid="raised-question-summary">
        {q.summary ?? t("questionDesk.withheld")}
      </p>
      {q.state === "owed" ? (
        <p className="text-13 text-muted" data-testid="raised-question-owed-by" data-owed-by={q.owedBy}>
          {t(OWED_BY[q.owedBy ?? "members"], { key: q.target.key })}
        </p>
      ) : q.state === "closed" ? (
        <p className="text-13 text-muted" data-testid="raised-question-closed">
          {t("questionDesk.closedOn", { key: q.target.key })}
        </p>
      ) : (
        <div className="grid gap-1 border-l-2 border-line pl-3" data-testid="raised-question-answer">
          <p className="flex flex-wrap items-center gap-2 text-12 text-muted">
            <ActorChip name={q.answer?.author.name ?? t("questionDesk.someone")} kind={q.answer?.author.agency ?? "human"} size={16} />
            {q.answer ? <span title={time.dateTime(q.answer.at)}>{time.relative(q.answer.at)}</span> : null}
          </p>
          <p className="min-w-0 break-words text-13 text-fg">{q.answer?.summary ?? t("questionDesk.withheld")}</p>
        </div>
      )}
    </li>
  );
}

export function RaisedList({ questions, slug, showAsker }: { questions: readonly RaisedQuestionView[]; slug: string; showAsker: boolean }) {
  return (
    <ul className="divide-y divide-line-subtle" data-testid="raised-questions">
      {questions.map((q) => (
        <RaisedQuestion key={q.id} q={q} slug={slug} showAsker={showAsker} />
      ))}
    </ul>
  );
}

const GROUP: Record<Exclude<RaisedQuestionState, "owed">, ProductCopyKey> = {
  answered: "questionDesk.group.answered",
  closed: "questionDesk.group.closed",
};

/** What is left to read of a group: its rows so far, a Show more while core holds more, or its refusal. */
export function RaisedPage({ group, slug, showAsker, state }: { group: ReturnType<typeof useRaisedGroup>; slug: string; showAsker: boolean; state: RaisedQuestionState }) {
  const t = useCopy();
  const { query, rows } = group;
  if (query.isError && rows.length === 0)
    return (
      <p className="text-13 text-danger" role="alert">
        {formatApiError(query.error)}
      </p>
    );
  if (!query.data) return <Skeleton className="h-16 w-full" />;
  return (
    <>
      {rows.length > 0 ? <RaisedList questions={rows} slug={slug} showAsker={showAsker} /> : null}
      {query.hasNextPage ? (
        <Button type="button" variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid={`raised-more-${state}`}>
          {t("questionDesk.showMore")}
        </Button>
      ) : null}
    </>
  );
}

/** The answered or closed questions as one count, opened on a click to their newest page; none, no toggle. */
export function RaisedGroup({ projectId, by, state, count, slug, showAsker }: { projectId: string; by: RaisedQuestionAsker; state: Exclude<RaisedQuestionState, "owed">; count: number; slug: string; showAsker: boolean }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const group = useRaisedGroup(projectId, by, state, open);
  if (count === 0) return null;
  return (
    <div className="grid gap-1 border-t border-line-subtle pt-2">
      <button
        type="button"
        className="flex w-fit items-center gap-1.5 py-1 text-13 font-medium text-muted hover:text-fg"
        aria-expanded={open}
        data-testid={`raised-group-${state}`}
        onClick={() => {
          if (open) group.fold();
          setOpen(!open);
        }}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        {t(GROUP[state], { count })}
      </button>
      {open ? <RaisedPage group={group} slug={slug} showAsker={showAsker} state={state} /> : null}
    </div>
  );
}
