// The project's Questions page, for the person who owns the product layer: the questions waiting on
// them, answered here through the one needs-me read the project home and the chat draw (REQ-41 BC-1,
// `DecisionList`, its `answer` group), so the three never disagree; then the questions they raised,
// each owed or answered, and the form that raises one.

import type { RaisedQuestionAsker } from "@forge/contracts/comments";
import { useState } from "react";
import { Button, EmptyState, ReportPage, Section, SegmentedControl, Skeleton } from "@/design";
import { DecisionList, useNeedsYouDecisions } from "@/features/needs-you";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRaisedQuestions } from "../hooks";
import { AskForm } from "./ask-form";
import { RaisedList } from "./raised-list";

function ForYou({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useNeedsYouDecisions(projectId);
  const owed = q.data?.decisions.filter((d) => d.group === "answer").length;
  return (
    <Section title={t("questionDesk.forYou")} right={owed !== undefined ? <span className="text-13 tabular-nums text-muted">{owed}</span> : null} testId="question-desk-for-you">
      {q.data ? (
        <DecisionList read={q.data} slug={slug} only="answer" />
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert">
          {formatApiError(q.error)}
        </p>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
    </Section>
  );
}

function Raised({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const [by, setBy] = useState<RaisedQuestionAsker>("me");
  const [asking, setAsking] = useState(false);
  const q = useRaisedQuestions(projectId, by);
  return (
    <Section
      title={t("questionDesk.raised")}
      right={
        <>
          <SegmentedControl
            value={by}
            onChange={setBy}
            options={[
              { value: "me", label: t("questionDesk.by.me") },
              { value: "people", label: t("questionDesk.by.people") },
            ]}
          />
          <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setAsking(true)} disabled={asking} data-testid="question-desk-ask">
            {t("questionDesk.ask")}
          </Button>
        </>
      }
      testId="question-desk-raised"
    >
      {asking ? (
        <div className="mb-4 border-b border-line-subtle pb-4">
          <AskForm projectId={projectId} onDone={() => setAsking(false)} />
        </div>
      ) : null}
      {q.data ? (
        <>
          <p className="text-13 text-muted" data-testid="question-desk-counts">
            {t("questionDesk.counts", { owed: q.data.owed, answered: q.data.answered, closed: q.data.closed })}
          </p>
          {q.data.questions.length === 0 ? (
            <EmptyState message={t("questionDesk.raisedEmpty")} />
          ) : (
            <RaisedList questions={q.data.questions} slug={slug} showAsker={by === "people"} />
          )}
        </>
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert">
          {formatApiError(q.error)}
        </p>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Section>
  );
}

export function QuestionDesk({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  return (
    <ReportPage title={t("questionDesk.title")} testId="question-desk">
      <div className="grid max-w-3xl gap-2">
        <ForYou projectId={projectId} slug={slug} />
        <Raised projectId={projectId} slug={slug} />
      </div>
    </ReportPage>
  );
}
