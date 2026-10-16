// The project's Questions page, for the person who owns the product layer: the questions waiting on
// them, answered here through the one needs-me read the project home and the chat draw (REQ-41 BC-1,
// `DecisionList`, its `answer` group), so the three never disagree; then the questions they raised,
// owed first, the answered and closed ones each a count opened on a click, and the form that raises one.

import type { RaisedQuestionAsker } from "@forge/contracts/comments";
import { useState } from "react";
import { Button, EmptyState, ReportPage, Section, SegmentedControl, Skeleton } from "@/design";
import { DecisionList, useNeedsYouDecisions } from "@/features/needs-you";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRaisedGroup } from "../hooks";
import { AskForm } from "./ask-form";
import { RaisedGroup, RaisedPage } from "./raised-list";

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
  const owed = useRaisedGroup(projectId, by, "owed");
  const counts = owed.counts;
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
      {counts ? (
        <>
          <p className="text-13 text-muted" data-testid="question-desk-counts">
            {t("questionDesk.counts", { owed: counts.owed, answered: counts.answered, closed: counts.closed })}
          </p>
          {counts.owed + counts.answered + counts.closed === 0 ? (
            <EmptyState message={t("questionDesk.raisedEmpty")} />
          ) : (
            <div className="grid gap-2" key={by}>
              {counts.owed === 0 ? (
                <p className="py-2 text-13 text-muted" data-testid="raised-owed-none">
                  {t("questionDesk.owedNone")}
                </p>
              ) : (
                <RaisedPage group={owed} slug={slug} showAsker={by === "people"} state="owed" />
              )}
              <RaisedGroup projectId={projectId} by={by} state="answered" count={counts.answered} slug={slug} showAsker={by === "people"} />
              <RaisedGroup projectId={projectId} by={by} state="closed" count={counts.closed} slug={slug} showAsker={by === "people"} />
            </div>
          )}
        </>
      ) : owed.query.isError ? (
        <p className="text-13 text-danger" role="alert">
          {formatApiError(owed.query.error)}
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
