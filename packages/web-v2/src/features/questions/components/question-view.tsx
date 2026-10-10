"use client";

// One `agent_questions` row, rendered wherever it is reached from — the issue's
// own panel and the project-wide queue on the Agents screen.
//
// The card owns the rules that make an irreversible submit safe, and it owns
// them BECAUSE it is shared: whoever mounts it supplies only a way to send and a
// pending flag, so neither caller can reconstruct a round or re-derive a lock.

import { useState } from "react";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { type ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { holdLine, isAnswerable, outcomeOf, resumeLine, type SuggestedAnswer, suggestedAnswerOf } from "./question-lines";

export { outcomeOf } from "./question-lines";
import {
  Badge,
  Button,
  Checkbox,
  Section,
  Field,
  EnumBadge,
  StatusBadge,
  Textarea,
} from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker";
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

const AUTHORITY_MEANS: Record<OptionAuthority, ProductCopyKey> = {
  writer: "agents.question.authority.writer",
  admin: "agents.question.authority.admin",
};
const BINDS_MEANS: Record<OptionBinding, ProductCopyKey> = {
  this_call: "agents.question.binds.this_call",
  session: "agents.question.binds.session",
  project: "agents.question.binds.project",
};
const EXECUTOR_MEANS: Record<OptionExecutor, ProductCopyKey> = {
  agent: "agents.question.executor.agent",
  core: "agents.question.executor.core",
  human: "agents.question.executor.human",
};

function OptionMeaning({ option, id }: { option: VisibleOption; id: string }) {
  const t = useCopy();
  return (
    <ul id={id} className="fg-caption mt-1 space-y-0.5 text-muted">
      <li>{t(AUTHORITY_MEANS[option.authority])}</li>
      <li>{t(BINDS_MEANS[option.bindsTo])}</li>
      <li>{t(EXECUTOR_MEANS[option.executedBy])}</li>
      {option.fingerprint && <li>{t("agents.question.names", { call: option.fingerprint })}</li>}
    </ul>
  );
}

function QuestionOption({
  option,
  recommended,
  suggested,
  answerable,
  pending,
  first,
  onChoose,
}: {
  option: VisibleOption;
  recommended: boolean;
  /** The recommendation is the assistant's, not the asker's. */
  suggested: boolean;
  answerable: boolean;
  pending: boolean;
  first: boolean;
  onChoose: (optionId: string) => void;
}) {
  const describedBy = `decision-option-${option.id}`;
  const t = useCopy();
  return (
    <div className="border-t border-line-subtle py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && (
          <Badge tone="accent">{t(suggested ? "agents.question.suggested" : "agents.question.recommended")}</Badge>
        )}
        {answerable && (
          <Button
            variant={recommended ? "primary" : "secondary"}
            size="sm"
            disabled={option.locked}
            loading={pending}
            data-first-option={first ? "true" : undefined}
            aria-label={t("agents.question.chooseLabel", { label: option.label })}
            aria-describedby={describedBy}
            onClick={() => onChoose(option.id)}
          >
            {t("agents.question.choose")}
          </Button>
        )}
      </div>
      {answerable && option.locked && (
        <p className="fg-caption mt-1 text-danger">
          {t("agents.question.needsAuthority", { authority: option.authority })}
        </p>
      )}
      <OptionMeaning option={option} id={describedBy} />
    </div>
  );
}

function RoundHistory({ step }: { step: QuestionStep }) {
  const t = useCopy();
  return (
    <div className="border-l-2 border-line-subtle py-1 pl-3">
      <p className="fg-caption text-subtle">{t("agents.question.round", { n: step.round })}</p>
      <p className="fg-body-sm mt-0.5 text-fg">{step.prompt}</p>
      {isChoiceStep(step) ? (
        <>
          <ul className="fg-caption mt-1 space-y-0.5 text-muted">
            {step.options.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.id === step.chosenOptionId ? t("agents.question.chosen") : ""}
              </li>
            ))}
          </ul>
          {step.chosenOptionId && (
            <p className="fg-caption mt-1 text-muted">
              {t("agents.question.answeredWith", {
                answer: step.options.find((o) => o.id === step.chosenOptionId)?.label ?? t("agents.question.optionGone"),
              })}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="fg-caption mt-1 text-muted">{t("agents.question.needed", { what: step.needed })}</p>
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
  recommended,
  suggested,
  locked,
  pending,
  onAnswer,
}: {
  needed: string;
  recommended: string | undefined;
  suggested: SuggestedAnswer | null;
  locked: boolean;
  pending: boolean;
  onAnswer: (text: string) => void;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  if (locked) {
    return (
      <p className="fg-caption text-danger">
        {t("agents.question.lockedText")}
      </p>
    );
  }

  const offered = recommended?.trim()
    ? { by: "asker" as const, text: recommended.trim(), why: null }
    : suggested
      ? { by: "assistant" as const, text: suggested.text, why: suggested.why }
      : null;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          setFault(t("agents.question.writeFirst"));
          return;
        }
        setFault(null);
        onAnswer(text.trim());
      }}
    >
      {offered && (
        <div className="space-y-1.5" data-testid="question-offered-answer" data-by={offered.by}>
          <p className="fg-caption text-muted">
            <span className="font-semibold text-fg">
              {t(offered.by === "assistant" ? "agents.question.suggestedBy" : "agents.question.recommendedBy")}:
            </span>{" "}
            {offered.text}
            {offered.why ? ` ${offered.why}` : ""}
          </p>
          <Button type="button" variant="primary" size="sm" loading={pending} onClick={() => onAnswer(offered.text)}>
            {t(offered.by === "assistant" ? "agents.question.sendSuggested" : "agents.question.sendRecommended")}
          </Button>
        </div>
      )}
      <Field label={t("agents.question.yourAnswer")} hint={needed ? t("agents.question.needed", { what: needed }) : undefined} error={fault ?? undefined}>
        <Textarea
          value={text}
          rows={4}
          data-first-option="true"
          placeholder={t("agents.question.tellRun")}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="sm" loading={pending}>
        {t("agents.question.send")}
      </Button>
    </form>
  );
}

interface WaitDraft {
  on: boolean;
  reason: string;
  /** The blocking issue, picked from the project's issues; empty for none. */
  blockedBy: IssuePick[];
}

const NO_WAIT: WaitDraft = { on: false, reason: "", blockedBy: [] };

/**
 * An answer that does not release its issue: what it still waits on, and the issue whose blocks
 * edge holds it, sent with the answer as `stillWaits` (ISS-257).
 */
function StillWaitsFields({
  projectId,
  draft,
  fault,
  onChange,
}: {
  projectId: string;
  draft: WaitDraft;
  fault: string | null;
  onChange: (next: WaitDraft) => void;
}) {
  const t = useCopy();
  return (
    <div className="space-y-2" data-testid="still-waits">
      <Checkbox
        checked={draft.on}
        onChange={(on) => onChange({ ...draft, on })}
        label={t("agents.question.stillWaitsBox")}
      />
      {draft.on && (
        <div className="space-y-2 pl-7">
          <Field label={t("agents.question.waitsOn")} required error={fault ?? undefined}>
            <Textarea
              rows={2}
              value={draft.reason}
              placeholder={t("agents.question.waitsOnExample")}
              onChange={(e) => onChange({ ...draft, reason: e.target.value })}
            />
          </Field>
          <Field label={t("agents.question.blockedBy")}>
            <IssuePicker
              projectId={projectId}
              value={draft.blockedBy}
              onChange={(blockedBy) => onChange({ ...draft, blockedBy })}
              ariaLabel={t("agents.question.blockedBy")}
              single
            />
          </Field>
        </div>
      )}
    </div>
  );
}

interface QuestionViewProps {
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
export function QuestionView({
  question,
  onAnswer,
  pending,
  context,
  highlighted,
}: QuestionViewProps) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const current = currentRoundOf(question);
  const askedOption = question.options.find((o) => o.id === question.recommendedOptionId)?.id;
  const suggested = suggestedAnswerOf(question, current);
  const answerable = isAnswerable(question);
  const outcome = outcomeOf(question, language);
  const earlier = earlierRoundsOf(question);
  const hidden = earlier.length === 0 ? roundCountOf(question) - 1 : 0;
  const firstEnabledId = answerable ? (question.options.find((o) => !o.locked)?.id ?? null) : null;
  const [wait, setWait] = useState<WaitDraft>(NO_WAIT);
  const [waitFault, setWaitFault] = useState<string | null>(null);
  const holds = answerable && question.issueId !== null;
  const hold = holdLine(current?.hold, t);
  const resume = resumeLine(current?.resume, t, language);

  const send = (round: number, given: GivenAnswer) => {
    if (holds && wait.on && !wait.reason.trim()) {
      setWaitFault(t("agents.question.sayWaits"));
      return;
    }
    setWaitFault(null);
    const blockedBy = wait.blockedBy[0]?.key;
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
    <Section
      data-question-id={question.id}
      className={cn("space-y-3", highlighted && "shadow-focus")}
      title={
        <span data-question-title="true" tabIndex={-1} className="focus-visible:outline-none focus-visible:shadow-focus">
          {answerable ? t("agents.question.waiting") : t("agents.question.decision")}
        </span>
      }
      right={
        <>
          <EnumBadge family="blockerKind" value={question.blockerKind} />
          <StatusBadge family="question" value={question.status} />
          {context}
        </>
      }
    >
        {earlier.length > 0 && (
          <div className="space-y-2">
            {earlier.map((step) => (
              <RoundHistory key={step.round} step={step} />
            ))}
          </div>
        )}
        {hidden > 0 && (
          <p className="fg-caption text-subtle">
            {hidden === 1 ? t("agents.question.earlierOne") : t("agents.question.earlierMany", { n: hidden })}
            {question.issueId
              ? hidden === 1
                ? t("agents.question.openToReadOne")
                : t("agents.question.openToReadMany")
              : t("agents.question.notShown")}
          </p>
        )}

        {current && (
          <div className="space-y-2">
            <p className="fg-caption text-subtle">{t("agents.question.round", { n: current.round })}</p>
            {current.prompt && <p className="fg-body text-fg">{current.prompt}</p>}
            {question.status === "open" && question.awaitsMerge && (
              <p className="fg-body-sm text-fg" data-testid="waits-on-mark">
                {t("agents.question.waitsOnMark", { key: question.awaitsMerge.key })}
              </p>
            )}
            {holds && <StillWaitsFields projectId={question.projectId} draft={wait} fault={waitFault} onChange={setWait} />}
            {question.answerShape === "choice" ? (
              question.options.map((option) => (
                <QuestionOption
                  key={option.id}
                  option={option}
                  recommended={option.id === (askedOption ?? suggested?.optionId)}
                  suggested={askedOption === undefined && option.id === suggested?.optionId}
                  answerable={answerable}
                  pending={pending}
                  first={option.id === firstEnabledId}
                  onChoose={(optionId) => send(current.round, { optionId })}
                />
              ))
            ) : answerable ? (
              <FreeTextAnswer
                key={current.round}
                recommended={!isChoiceStep(current) ? current.recommended : undefined}
                suggested={suggested}
                needed={question.needed}
                locked={question.locked}
                pending={pending}
                onAnswer={(text) => send(current.round, { text })}
              />
            ) : (
              question.needed && <p className="fg-caption text-muted">{t("agents.question.needed", { what: question.needed })}</p>
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
    </Section>
  );
}
