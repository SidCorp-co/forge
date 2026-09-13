"use client";

// The structured decision a parked run is waiting on, on the issue screen.
//
// This is the `agent_questions` ROW, and since ISS-996 it is the ONLY lane: a
// park at `needs_info` mints its own question, answered by option or in words.
// The comment thread below records what was asked; answering there moves
// nothing.

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  MonoTag,
  Skeleton,
  Textarea,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAnswerQuestion, useIssueQuestions } from "../hooks";
import {
  type AgentQuestion,
  isChoiceStep,
  type OptionAuthority,
  type OptionBinding,
  type OptionExecutor,
  type QuestionStep,
  type VisibleOption,
} from "../types";

// cm:guard exported and imported rather than spelled twice: the blocker banner's "Provide info" CTA scrolls to this element, and a renamed string on one side alone leaves that CTA silently doing nothing (ISS-996).
export const DECISION_PANEL_ANCHOR = "issue-decisions";

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

// cm:guard an earlier round renders by its OWN shape and never by the question's current one: a decision that asked for a choice and then followed up in words carries both, and reading the row's shape here would list options a text round never had (ISS-996).
function RoundHistory({ step }: { step: QuestionStep }) {
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <p className="fg-caption text-subtle">Round {step.round}</p>
      <p className="fg-body-sm mt-0.5 text-fg">{step.prompt}</p>
      {isChoiceStep(step) ? (
        <>
          <ul className="fg-caption mt-1 space-y-0.5 text-muted">
            {step.options.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.id === step.chosenOptionId ? " — chosen" : ""}
              </li>
            ))}
          </ul>
          {step.chosenOptionId && (
            <p className="fg-caption mt-1 text-muted">
              Answered:{" "}
              {step.options.find((o) => o.id === step.chosenOptionId)?.label ??
                "an option no longer on this round"}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="fg-caption mt-1 text-muted">Needed: {step.needed}</p>
          {step.answerText && (
            <p className="fg-body-sm mt-1 whitespace-pre-wrap text-fg">{step.answerText}</p>
          )}
        </>
      )}
    </div>
  );
}

// cm:guard the empty answer is refused HERE and the button stays enabled to do it: a disabled submit under an empty box tells a person nothing about why, and core would refuse the blank body anyway (ISS-996).
function FreeTextAnswer({
  needed,
  locked,
  pending,
  onAnswer,
}: {
  needed: string;
  locked: boolean;
  pending: boolean;
  onAnswer: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  if (locked) {
    return (
      <p className="fg-caption text-danger">
        Answering this needs access to the project this issue belongs to.
      </p>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          setFault("Write what the run asked for before sending it.");
          return;
        }
        setFault(null);
        onAnswer(text.trim());
        setText("");
      }}
    >
      <Field label="Your answer" hint={needed ? `Needed: ${needed}` : undefined} error={fault ?? undefined}>
        <Textarea
          value={text}
          rows={4}
          placeholder="Tell the run what it needs to know"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="sm" loading={pending}>
        Send answer
      </Button>
    </form>
  );
}

// cm:guard the answer form is gated on `human` as well as on `open`: a `machine` or `master_or_peer` blocker resolves without a person, and putting a button under one asks somebody to settle a decision that was never theirs (ISS-980 criterion 15).
function isAnswerable(question: AgentQuestion): boolean {
  return question.status === "open" && question.blockerKind === "human";
}

function answeredWith(last: QuestionStep | undefined): string {
  if (!last) return "no round on the record";
  if (!isChoiceStep(last)) return last.answerText ?? "in words, no longer on the record";
  return (
    last.options.find((o) => o.id === last.chosenOptionId)?.label ??
    last.chosenOptionId ??
    "an option no longer on this round"
  );
}

function outcomeOf(question: AgentQuestion): string | null {
  const last = question.steps[question.steps.length - 1];
  if (question.status === "answered") {
    return `Answered — ${answeredWith(last)}`;
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
              <RoundHistory key={step.round} step={step} />
            ))}
          </div>
        )}

        {current && (
          <div className="space-y-2">
            <p className="fg-caption text-subtle">Round {current.round}</p>
            {current.prompt && <p className="fg-body text-fg">{current.prompt}</p>}
            {question.answerShape === "choice" ? (
              question.options.map((option) => (
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
              ))
            ) : answerable ? (
              <FreeTextAnswer
                needed={question.needed}
                locked={question.locked}
                pending={answer.isPending}
                onAnswer={(text) =>
                  answer.mutate({ questionId: question.id, text, round: current.round })
                }
              />
            ) : (
              question.needed && (
                <p className="fg-caption text-muted">Needed: {question.needed}</p>
              )
            )}
          </div>
        )}

        {outcome && <p className="fg-body-sm text-muted">{outcome}</p>}
      </CardContent>
    </Card>
  );
}

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
          <QuestionCard key={question.id} question={question} issueId={issueId} />
        ))
      )}
    </div>
  );
}
