"use client";

// The structured decision a parked run is waiting on, on the issue screen.
//
// This is the `agent_questions` ROW. The agent's prose question is a comment in
// the thread below and `blocker-banner.tsx` deliberately does not duplicate it —
// that is a different lane and stays one.

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ErrorState, MonoTag, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAnswerQuestion, useIssueQuestions } from "../hooks";
import type {
  AgentQuestion,
  OptionAuthority,
  OptionBinding,
  OptionExecutor,
  QuestionStep,
  VisibleOption,
} from "../types";

// cm:guard the three attributes are rendered as what they MEAN for the reader, never as their stored values: `bindsTo: 'session'` tells a person nothing, and a decision whose reach the reader cannot state is one they cannot make (ISS-980 criteria 3, 4, 5).
const AUTHORITY_MEANS: Record<OptionAuthority, string> = {
  writer: "Any project member can choose this",
  admin: "Only a project admin can choose this",
};
const BINDS_MEANS: Record<OptionBinding, string> = {
  this_call: "Applies to this one call only",
  session: "Applies for the rest of this session",
  project: "Applies to this project from now on",
};
const EXECUTOR_MEANS: Record<OptionExecutor, string> = {
  agent: "The agent carries this out",
  core: "Forge carries this out",
  human: "You carry this out",
};

function OptionMeaning({ option, id }: { option: VisibleOption; id: string }) {
  return (
    <ul id={id} className="fg-caption mt-1 space-y-0.5 text-muted">
      <li>{AUTHORITY_MEANS[option.authority]}</li>
      <li>{BINDS_MEANS[option.bindsTo]}</li>
      <li>{EXECUTOR_MEANS[option.executedBy]}</li>
      {option.fingerprint && <li>Names the call: {option.fingerprint}</li>}
    </ul>
  );
}

function OptionRow({
  option,
  recommended,
  answerable,
  pending,
  onChoose,
}: {
  option: VisibleOption;
  recommended: boolean;
  answerable: boolean;
  pending: boolean;
  onChoose: (optionId: string) => void;
}) {
  // cm:guard every button on this panel submits immediately, so each one's ACCESSIBLE name has to say which decision it makes: navigating by button, a bare "Choose" repeated per option is a list of identical irreversible controls (ISS-980).
  const describedBy = `decision-option-${option.id}`;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && <Badge tone="accent">Recommended</Badge>}
        {answerable && (
          // cm:guard `disabled` comes from the SERVER's `locked` and from nothing else — no role read, no second rule. A locked option stays on screen and refuses, because hiding it leaves a queue of decisions only one person can even see (ISS-964 criterion 15).
          <Button
            variant={recommended ? "primary" : "secondary"}
            size="sm"
            disabled={option.locked}
            loading={pending}
            aria-label={`Choose ${option.label}`}
            aria-describedby={describedBy}
            onClick={() => onChoose(option.id)}
          >
            Choose
          </Button>
        )}
      </div>
      {answerable && option.locked && (
        <p className="fg-caption mt-1 text-danger">
          Needs the &quot;{option.authority}&quot; authority
        </p>
      )}
      <OptionMeaning option={option} id={describedBy} />
    </div>
  );
}

function RoundHistory({ step, chosenLabel }: { step: QuestionStep; chosenLabel: string | null }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <p className="fg-caption text-subtle">Round {step.round}</p>
      <p className="fg-body-sm mt-0.5 text-fg">{step.prompt}</p>
      <ul className="fg-caption mt-1 space-y-0.5 text-muted">
        {step.options.map((o) => (
          <li key={o.id}>
            {o.label}
            {o.id === step.chosenOptionId ? " — chosen" : ""}
          </li>
        ))}
      </ul>
      {chosenLabel && <p className="fg-caption mt-1 text-muted">Answered: {chosenLabel}</p>}
    </div>
  );
}

// cm:guard the answer form is gated on `human` as well as on `open`: a `machine` or `master_or_peer` blocker resolves without a person, and putting a button under one asks somebody to settle a decision that was never theirs (ISS-980 criterion 15).
function isAnswerable(question: AgentQuestion): boolean {
  return question.status === "open" && question.blockerKind === "human";
}

function outcomeOf(question: AgentQuestion): string | null {
  const last = question.steps[question.steps.length - 1];
  const chosen = last?.options.find((o) => o.id === last.chosenOptionId);
  if (question.status === "answered") {
    return `Answered — ${chosen?.label ?? last?.chosenOptionId ?? "an option no longer on this round"}`;
  }
  if (question.status === "void") {
    return `Withdrawn — ${question.voidReason ?? "no reason recorded"}`;
  }
  if (question.status === "expired") {
    return `Expired unanswered — ${question.endedReason ?? "the park deadline passed"}`;
  }
  if (question.status === "needs_info") {
    return "Out of rounds — the thread is the record now";
  }
  return null;
}

function QuestionCard({ question, issueId }: { question: AgentQuestion; issueId: string }) {
  const answer = useAnswerQuestion(issueId);
  const current = question.steps[question.steps.length - 1];
  const answerable = isAnswerable(question);
  const outcome = outcomeOf(question);
  const earlier = question.steps.slice(0, -1);

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <CardTitle>{answerable ? "Decision waiting" : "Decision"}</CardTitle>
        <MonoTag>{question.blockerKind}</MonoTag>
        <MonoTag>{question.status}</MonoTag>
      </CardHeader>
      <CardContent className="space-y-3">
        {earlier.length > 0 && (
          <div className="space-y-2">
            {earlier.map((step) => (
              <RoundHistory
                key={step.round}
                step={step}
                chosenLabel={
                  step.options.find((o) => o.id === step.chosenOptionId)?.label ?? null
                }
              />
            ))}
          </div>
        )}

        {current && (
          <div className="space-y-2">
            <p className="fg-caption text-subtle">Round {current.round}</p>
            <p className="fg-body text-fg">{current.prompt}</p>
            {question.options.map((option) => (
              <OptionRow
                key={option.id}
                option={option}
                recommended={option.id === question.recommendedOptionId}
                answerable={answerable}
                pending={answer.isPending}
                onChoose={(optionId) =>
                  answer.mutate({ questionId: question.id, optionId, round: current.round })
                }
              />
            ))}
          </div>
        )}

        {outcome && <p className="fg-body-sm text-muted">{outcome}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Every question on this issue, or nothing at all when it has none.
 */
// cm:guard the empty, loading and failed reads are THREE different renders. Collapsing a failed read into the empty one makes a decision somebody owes disappear from the screen with no way to tell it apart from an issue that never had one (ISS-980 criteria 16, 17, 18).
export function DecisionPanel({ issueId }: { issueId: string }) {
  const { data, isLoading, isError, error, refetch } = useIssueQuestions(issueId);

  if (isLoading) return <Skeleton variant="rect" className="h-24 w-full" />;
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load this issue's decisions"
        message={formatApiError(error)}
        onRetry={() => refetch()}
      />
    );
  }
  const questions = data?.questions ?? [];
  if (questions.length === 0) return null;

  return (
    <div className="space-y-3">
      {questions.map((question) => (
        <QuestionCard key={question.id} question={question} issueId={issueId} />
      ))}
    </div>
  );
}
