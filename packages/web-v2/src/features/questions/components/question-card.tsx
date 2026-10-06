"use client";

// One `agent_questions` row, rendered wherever it is reached from — the issue's
// own panel and the project-wide queue on the Agents screen.
//
// The card owns the rules that make an irreversible submit safe, and it owns
// them BECAUSE it is shared: whoever mounts it supplies only a way to send and a
// pending flag, so neither caller can reconstruct a round or re-derive a lock.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import type { AnswerHold, AnswerResume } from "@forge/contracts/questions";
import { useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  Field,
  EnumBadge,
  StatusBadge,
  Textarea,
} from "@/design";
import {
  type AgentQuestion,
  type AnswerInput,
  currentRoundOf,
  type GivenAnswer,
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
    <div className="border-t border-line-subtle py-2.5">
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
    <div className="border-l-2 border-line-subtle py-1 pl-3">
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

/** What the answer said the issue still waits on, as the answered card shows it. */
export function holdLine(hold: AnswerHold | undefined): string | null {
  if (!hold) return null;
  return hold.blockedBy
    ? `Still waits on ${hold.blockedBy.key}: ${hold.reason}`
    : `Still waits: ${hold.reason}`;
}

const statusWord = (status: string) =>
  ISSUE_STATUS_LABELS[status as keyof typeof ISSUE_STATUS_LABELS] ?? status;

/** What the answer did to the issue it stopped, in a reader's words; null until core recorded it. */
export function resumeLine(resume: AnswerResume | undefined): string | null {
  switch (resume?.kind) {
    case undefined:
      return null;
    case "resumed":
      return `The issue went back to ${statusWord(resume.to)}.`;
    case "sent_to_run":
      return "The answer went to the run that asked; it moves the issue on.";
    case "box_reads":
      return "A box is reading this answer back; its run moves the issue on.";
    case "other_question":
      return "The issue still waits on another open question.";
    case "held":
      return "The issue stays parked, as this answer said.";
    case "no_left_status":
      return "Nothing recorded where the issue picks up again — move it on from its status.";
    case "staged":
      return "This project does not move an issue on an answer — resume it from its status.";
    case "refused":
      return `The issue did not move on: ${resume.code} — ${resume.detail}`;
  }
}

interface WaitDraft {
  on: boolean;
  reason: string;
  blockedBy: string;
}

const NO_WAIT: WaitDraft = { on: false, reason: "", blockedBy: "" };

/**
 * An answer that does not release its issue: what it still waits on, and the issue whose blocks
 * edge holds it, sent with the answer as `stillWaits` (ISS-257).
 */
function StillWaitsFields({
  draft,
  fault,
  onChange,
}: {
  draft: WaitDraft;
  fault: string | null;
  onChange: (next: WaitDraft) => void;
}) {
  return (
    <div className="space-y-2" data-testid="still-waits">
      <Checkbox
        checked={draft.on}
        onChange={(on) => onChange({ ...draft, on })}
        label="The issue still waits after this answer"
      />
      {draft.on && (
        <div className="space-y-2 pl-7">
          <Field label="What it still waits on" required error={fault ?? undefined}>
            <Textarea
              rows={2}
              value={draft.reason}
              placeholder="e.g. both design revisions approved"
              onChange={(e) => onChange({ ...draft, reason: e.target.value })}
            />
          </Field>
          <Field label="Blocked by issue" hint="Optional. Its blocks edge releases this issue once it settles.">
            <Input
              value={draft.blockedBy}
              placeholder="ISS-12"
              onChange={(e) => onChange({ ...draft, blockedBy: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

interface QuestionCardProps {
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
  const [wait, setWait] = useState<WaitDraft>(NO_WAIT);
  const [waitFault, setWaitFault] = useState<string | null>(null);
  const holds = answerable && question.issueId !== null;
  const hold = holdLine(current?.hold);
  const resume = resumeLine(current?.resume);

  const send = (round: number, given: GivenAnswer) => {
    if (holds && wait.on && !wait.reason.trim()) {
      setWaitFault("Say what the issue still waits on, or untick the box.");
      return;
    }
    setWaitFault(null);
    const blockedBy = wait.blockedBy.trim();
    onAnswer({
      questionId: question.id,
      round,
      ...given,
      ...(holds && wait.on
        ? { stillWaits: { reason: wait.reason.trim(), ...(blockedBy ? { blockedBy } : {}) } }
        : {}),
    });
  };

  return (
    <PageSection
      data-question-id={question.id}
      className={highlighted ? "shadow-[var(--shadow-focus)]" : undefined}
    >
      <PageSectionHeader className="flex flex-wrap items-center gap-2">
        <PageSectionTitle
          data-question-title="true"
          tabIndex={-1}
          className="focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {answerable ? "Decision waiting" : "Decision"}
        </PageSectionTitle>
        <EnumBadge family="blockerKind" value={question.blockerKind} />
        <StatusBadge family="question" value={question.status} />
        {context}
      </PageSectionHeader>
      <PageSectionBody className="space-y-3">
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
            {holds && <StillWaitsFields draft={wait} fault={waitFault} onChange={setWait} />}
            {question.answerShape === "choice" ? (
              question.options.map((option) => (
                <OptionRow
                  key={option.id}
                  option={option}
                  recommended={option.id === question.recommendedOptionId}
                  answerable={answerable}
                  pending={pending}
                  first={option.id === firstEnabledId}
                  onChoose={(optionId) => send(current.round, { optionId })}
                />
              ))
            ) : answerable ? (
              <FreeTextAnswer
                key={current.round}
                needed={question.needed}
                locked={question.locked}
                pending={pending}
                onAnswer={(text) => send(current.round, { text })}
              />
            ) : (
              question.needed && <p className="fg-caption text-muted">Needed: {question.needed}</p>
            )}
          </div>
        )}

        {outcome && <p className="fg-body-sm text-muted">{outcome}</p>}
        {hold && <p className="fg-body-sm text-fg">{hold}</p>}
        {resume && (
          <p className="fg-caption text-muted" data-testid="answer-resume">
            {resume}
          </p>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
