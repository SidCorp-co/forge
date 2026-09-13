"use client";

// The structured decision a parked run is waiting on, on the issue screen.
//
// This is the `agent_questions` ROW, and since ISS-996 it is the ONLY lane: a
// park at `needs_info` mints its own question, answered by option or in words.
// The comment thread below records what was asked; answering there moves
// nothing.
//
// The card itself lives in `question-card.tsx` because the project-wide queue on
// the Agents screen renders the same one; this file is the issue-scoped fetch,
// its read states, and the park that carries no question at all.

import { Card, CardContent, CardHeader, CardTitle, ErrorState, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAnsweringQuestions, useAnswerQuestion, useIssueQuestions } from "../hooks";
import { QuestionCard } from "./question-card";

// cm:guard exported and imported rather than spelled twice: the blocker banner's "Provide info" CTA scrolls to this element, and a renamed string on one side alone leaves that CTA silently doing nothing (ISS-996).
export const DECISION_PANEL_ANCHOR = "issue-decisions";

// cm:guard a park with NO question is its own render and never the empty one: four issues sat at `needs_info` carrying zero question rows on 2026-09-13, every one of them parked before ISS-996, and rendering nothing under a banner whose CTA scrolls here left that CTA a silent no-op. What it says is what is true of both shapes of such a park — the agent's, minted before the lane existed, and a person's, which mints none by design.
function NothingToAnswer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Nothing to answer here</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="fg-body-sm text-fg">
          This issue was parked without a question, so there is no round to answer on this screen.
        </p>
        <p className="fg-caption text-muted">
          A comment does not restart the run. Once whoever is waiting has what they need, move the
          issue on from the header.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Every question on this issue — or, on an issue parked for information with none,
 * a statement that there is nothing here to answer.
 */
// cm:guard the empty, loading and failed reads are THREE different renders. Collapsing a failed read into the empty one makes a decision somebody owes disappear from the screen with no way to tell it apart from an issue that never had one (ISS-980 criteria 16, 17, 18).
// cm:guard the anchored element is rendered on EVERY arm once `parkedForInfo` holds, loading included: the blocker banner's CTA scrolls to this id, and an id that only exists once a fetch resolves makes that CTA do nothing for as long as the read is in flight.
export function DecisionPanel({
  issueId,
  parkedForInfo = false,
}: {
  issueId: string;
  parkedForInfo?: boolean;
}) {
  const { data, isLoading, isError, error, refetch } = useIssueQuestions(issueId);
  const mutation = useAnswerQuestion(issueId);
  const { answering, answer } = useAnsweringQuestions(mutation.mutateAsync);
  const questions = data?.questions ?? [];

  if (!parkedForInfo && !isLoading && !isError && questions.length === 0) return null;

  return (
    <div id={DECISION_PANEL_ANCHOR} className="space-y-3">
      {isLoading ? (
        <Skeleton variant="rect" className="h-24 w-full" />
      ) : isError ? (
        <ErrorState
          title="Couldn't load this issue's decisions"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      ) : questions.length === 0 ? (
        <NothingToAnswer />
      ) : (
        questions.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            onAnswer={answer}
            // cm:guard the pending flag is scoped to the question being answered and never read off the mutation: react-query keeps ONE `variables` slot, so a second answer submitted before the first settles released the first card's irreversible button while its answer was still on the wire (ISS-998).
            pending={answering.has(question.id)}
          />
        ))
      )}
    </div>
  );
}
