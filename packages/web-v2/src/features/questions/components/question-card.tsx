"use client";

// One `agent_questions` row, rendered wherever it is reached from — the issue's
// own panel and the project-wide queue on the Agents screen.
//
// The card owns the rules that make an irreversible submit safe, and it owns
// them BECAUSE it is shared: whoever mounts it supplies only a way to send and a
// pending flag, so neither caller can reconstruct a round or re-derive a lock.

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  MonoTag,
  Textarea,
} from "@/design";
import {
  type AgentQuestion,
  type AnswerInput,
  currentRoundOf,
  earlierRoundsOf,
  isChoiceStep,
  type OptionAuthority,
  type OptionBinding,
  type OptionExecutor,
  type QuestionStep,
  roundCountOf,
  type VisibleOption,
} from "../types";

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
  first,
  onChoose,
}: {
  option: VisibleOption;
  recommended: boolean;
  answerable: boolean;
  pending: boolean;
  first: boolean;
  onChoose: (optionId: string) => void;
}) {
  const describedBy = `decision-option-${option.id}`;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && <Badge tone="accent">Recommended</Badge>}
        {answerable && (
          <Button
            variant={recommended ? "primary" : "secondary"}
            size="sm"
            disabled={option.locked}
            loading={pending}
            data-first-option={first ? "true" : undefined}
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
      }}
    >
      <Field label="Your answer" hint={needed ? `Needed: ${needed}` : undefined} error={fault ?? undefined}>
        <Textarea
          value={text}
          rows={4}
          data-first-option="true"
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

export function isAnswerable(question: AgentQuestion): boolean {
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

export function outcomeOf(question: AgentQuestion): string | null {
  const last = currentRoundOf(question);
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

export interface QuestionCardProps {
  question: AgentQuestion;
  /** Send one answer. The card builds the whole input; the caller only transports it. */
  onAnswer: (input: AnswerInput) => void;
  /** Pending for THIS question. A flag shared across a list freezes cards nobody is answering. */
  pending: boolean;
  /** Optional heading slot — the project queue names the issue a question came from. */
  context?: React.ReactNode;
  /** Marks the card a link arrived on, so a reader can see which one was meant. */
  highlighted?: boolean;
}

/**
 * One decision, with its earlier rounds above it and its current round below.
 */
export function QuestionCard({
  question,
  onAnswer,
  pending,
  context,
  highlighted,
}: QuestionCardProps) {
  const current = currentRoundOf(question);
  const answerable = isAnswerable(question);
  const outcome = outcomeOf(question);
  const earlier = earlierRoundsOf(question);
  const hidden = earlier.length === 0 ? roundCountOf(question) - 1 : 0;
  const firstEnabledId = answerable ? (question.options.find((o) => !o.locked)?.id ?? null) : null;

  return (
    <Card
      data-question-id={question.id}
      className={highlighted ? "shadow-[var(--shadow-focus)]" : undefined}
    >
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle
          data-question-title="true"
          tabIndex={-1}
          className="focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {answerable ? "Decision waiting" : "Decision"}
        </CardTitle>
        <MonoTag>{question.blockerKind}</MonoTag>
        <MonoTag>{question.status}</MonoTag>
        {context}
      </CardHeader>
      <CardContent className="space-y-3">
        {earlier.length > 0 && (
          <div className="space-y-2">
            {earlier.map((step) => (
              <RoundHistory key={step.round} step={step} />
            ))}
          </div>
        )}
        {hidden > 0 && (
          <p className="fg-caption text-subtle">
            {hidden === 1 ? "1 earlier round" : `${hidden} earlier rounds`}
            {question.issueId
              ? hidden === 1
                ? " — open the issue to read it"
                : " — open the issue to read them"
              : ", not shown in this queue"}
          </p>
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
                  pending={pending}
                  first={option.id === firstEnabledId}
                  onChoose={(optionId) =>
                    onAnswer({ questionId: question.id, optionId, round: current.round })
                  }
                />
              ))
            ) : answerable ? (
              <FreeTextAnswer
                key={current.round}
                needed={question.needed}
                locked={question.locked}
                pending={pending}
                onAnswer={(text) =>
                  onAnswer({ questionId: question.id, text, round: current.round })
                }
              />
            ) : (
              question.needed && <p className="fg-caption text-muted">Needed: {question.needed}</p>
            )}
          </div>
        )}

        {outcome && <p className="fg-body-sm text-muted">{outcome}</p>}
      </CardContent>
    </Card>
  );
}
