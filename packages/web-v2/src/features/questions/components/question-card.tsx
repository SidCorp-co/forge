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
  isChoiceStep,
  type OptionAuthority,
  type OptionBinding,
  type OptionExecutor,
  type QuestionStep,
  type VisibleOption,
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
  // cm:guard every button on this panel submits immediately, so each one's ACCESSIBLE name has to say which decision it makes: navigating by button, a bare "Choose" repeated per option is a list of identical irreversible controls (ISS-980).
  const describedBy = `decision-option-${option.id}`;
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && <Badge tone="accent">Recommended</Badge>}
        {answerable && (
          // cm:guard `disabled` comes from the SERVER's `locked` and from nothing else — no role read, no second rule. A locked option stays on screen and refuses, because hiding it leaves a queue of decisions only one person can even see (ISS-964 criterion 15).
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
// cm:guard `data-first-option` rides on the TEXTAREA and not on the submit: it is the element the project queue moves focus to when this card takes an answered one's place, and focusing the button instead skips the box the answer has to be written in — the next keypress is then the empty-answer refusal rather than the start of the decision (ISS-996, ISS-998).
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

// cm:guard the answer form is gated on `human` as well as on `open`: a `machine` or `master_or_peer` blocker resolves without a person, and putting a button under one asks somebody to settle a decision that was never theirs (ISS-980 criterion 15).
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
// cm:guard `round` is taken from the step this card is RENDERING and is never accepted from the caller: core refuses an answer bound to any other round, and that refusal is the whole of the stale-screen protection. A parent that pre-bound the round would apply a choice made about round 1 to a round 3 nobody read (ISS-980 criterion 39).
// cm:guard the card is mounted from TWO places since ISS-998 — the issue panel and the project queue — and both rules above live here rather than in either caller, so neither can regress alone.
export function QuestionCard({
  question,
  onAnswer,
  pending,
  context,
  highlighted,
}: QuestionCardProps) {
  const current = question.steps[question.steps.length - 1];
  const answerable = isAnswerable(question);
  const outcome = outcomeOf(question);
  const earlier = question.steps.slice(0, -1);
  // cm:guard the marked option is the first ANSWERABLE one, never index zero: it is the target the project queue moves focus to after an answer, and a locked button takes focus nowhere. Where every option is locked there is no button to mark and the title below is the only destination (ISS-998).
  const firstEnabledId = answerable ? (question.options.find((o) => !o.locked)?.id ?? null) : null;
  // cm:guard the title below carries `data-question-title` and `tabIndex={-1}` so a card reached by a link, or one whose every option is server-locked, has a focus destination that is not the document body; -1 keeps it out of the tab order, where a heading stop would be a dead press on every screen (ISS-998).

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
