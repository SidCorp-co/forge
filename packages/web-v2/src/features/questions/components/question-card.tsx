"use client";

// One `agent_questions` row, rendered wherever it is reached from — the issue's
// own panel and the project-wide queue on the Agents screen.
//
// The card owns the rules that make an irreversible submit safe, and it owns
// them BECAUSE it is shared: whoever mounts it supplies only a way to send and a
// pending flag, so neither caller can reconstruct a round or re-derive a lock.

import type { AnswerHold, AnswerResume } from "@forge/contracts/questions";
import { useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  PageSection,
  PageSectionBody,
  PageSectionHeader,
  PageSectionTitle,
  Field,
  EnumBadge,
  StatusBadge,
  Textarea,
} from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker/issue-picker";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
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

// What an option's three declared properties mean, keyed to the locale file's `questions.*` words.
const authorityMeans = (t: Copy, a: OptionAuthority) => t(`questions.authority.${a}`);
const bindsMeans = (t: Copy, b: OptionBinding) => t(`questions.binds.${b}`);
const executorMeans = (t: Copy, e: OptionExecutor) => t(`questions.executor.${e}`);

function OptionMeaning({ option, id }: { option: VisibleOption; id: string }) {
  const t = useCopy();
  return (
    <ul id={id} className="fg-caption mt-1 space-y-0.5 text-muted">
      <li>{authorityMeans(t, option.authority)}</li>
      <li>{bindsMeans(t, option.bindsTo)}</li>
      <li>{executorMeans(t, option.executedBy)}</li>
      {option.fingerprint && <li>{t("questions.fingerprint", { fingerprint: option.fingerprint })}</li>}
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
  const t = useCopy();
  const describedBy = `decision-option-${option.id}`;
  return (
    <div className="border-t border-line-subtle py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && <Badge tone="accent">{t("questions.recommended")}</Badge>}
        {answerable && (
          <Button
            variant={recommended ? "primary" : "secondary"}
            size="sm"
            disabled={option.locked}
            loading={pending}
            data-first-option={first ? "true" : undefined}
            aria-label={t("questions.chooseAria", { label: option.label })}
            aria-describedby={describedBy}
            onClick={() => onChoose(option.id)}
          >
            {t("questions.choose")}
          </Button>
        )}
      </div>
      {answerable && option.locked && (
        <p className="fg-caption mt-1 text-danger">
          {t("questions.needsAuthority", { authority: option.authority })}
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
      <p className="fg-caption text-subtle">{t("questions.round", { round: step.round })}</p>
      <p className="fg-body-sm mt-0.5 text-fg">{step.prompt}</p>
      {isChoiceStep(step) ? (
        <>
          <ul className="fg-caption mt-1 space-y-0.5 text-muted">
            {step.options.map((o) => (
              <li key={o.id}>
                {o.label}
                {o.id === step.chosenOptionId ? t("questions.chosen") : ""}
              </li>
            ))}
          </ul>
          {step.chosenOptionId && (
            <p className="fg-caption mt-1 text-muted">
              {t("questions.answeredWith", {
                label: step.options.find((o) => o.id === step.chosenOptionId)?.label ?? t("questions.optionGone"),
              })}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="fg-caption mt-1 text-muted">{t("questions.needed", { needed: step.needed })}</p>
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
  const t = useCopy();
  const [text, setText] = useState("");
  const [fault, setFault] = useState<string | null>(null);

  if (locked) {
    return <p className="fg-caption text-danger">{t("questions.freeText.locked")}</p>;
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          setFault(t("questions.freeText.empty"));
          return;
        }
        setFault(null);
        onAnswer(text.trim());
      }}
    >
      <Field label={t("questions.freeText.label")} hint={needed ? t("questions.needed", { needed }) : undefined} error={fault ?? undefined}>
        <Textarea
          value={text}
          rows={4}
          data-first-option="true"
          placeholder={t("questions.freeText.placeholder")}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="sm" loading={pending}>
        {t("questions.freeText.send")}
      </Button>
    </form>
  );
}

function isAnswerable(question: AgentQuestion): boolean {
  return question.status === "open" && question.blockerKind === "human";
}

function answeredWith(t: Copy, last: QuestionStep | undefined): string {
  if (!last) return t("questions.outcome.noRound");
  if (!isChoiceStep(last)) return last.answerText ?? t("questions.outcome.inWords");
  return (
    last.options.find((o) => o.id === last.chosenOptionId)?.label ??
    last.chosenOptionId ??
    t("questions.optionGone")
  );
}

/** The one line that says how a settled question ended; the reason itself is core's or the answerer's own words. */
export function outcomeOf(t: Copy, question: AgentQuestion): string | null {
  const last = currentRoundOf(question);
  if (question.status === "answered") {
    return t("questions.outcome.answered", { what: answeredWith(t, last) });
  }
  if (question.status === "void") {
    return t("questions.outcome.void", { why: question.voidReason ?? t("questions.outcome.voidNoReason") });
  }
  if (question.status === "expired") {
    return t("questions.outcome.expired", { why: question.endedReason ?? t("questions.outcome.expiredNoReason") });
  }
  if (question.status === "needs_info") {
    return t("questions.outcome.needsInfo");
  }
  return null;
}

/** What the answer said the issue still waits on, as the answered card shows it. */
function holdLine(t: Copy, hold: AnswerHold | undefined): string | null {
  if (!hold) return null;
  return hold.blockedBy
    ? t("questions.hold.on", { key: hold.blockedBy.key, reason: hold.reason })
    : t("questions.hold.plain", { reason: hold.reason });
}

/** What the answer did to the issue it stopped, in a reader's words; null until core recorded it. */
function resumeLine(t: Copy, label: ReturnType<typeof useLabel>, resume: AnswerResume | undefined): string | null {
  switch (resume?.kind) {
    case undefined:
      return null;
    case "resumed":
      return t("questions.resume.resumed", { status: label("issueStatus", resume.to) });
    case "refused":
      return t("questions.resume.refused", { code: resume.code, detail: resume.detail });
    case "sent_to_run":
    case "box_reads":
    case "other_question":
    case "held":
    case "no_left_status":
    case "staged":
      return t(`questions.resume.${resume.kind}`);
  }
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
        label={t("questions.stillWaits.label")}
      />
      {draft.on && (
        <div className="space-y-2 pl-7">
          <Field label={t("questions.stillWaits.reason")} required error={fault ?? undefined}>
            <Textarea
              rows={2}
              value={draft.reason}
              placeholder={t("questions.stillWaits.placeholder")}
              onChange={(e) => onChange({ ...draft, reason: e.target.value })}
            />
          </Field>
          <Field label={t("questions.stillWaits.blockedBy")} hint={t("questions.stillWaits.blockedByHint")}>
            <IssuePicker
              projectId={projectId}
              value={draft.blockedBy}
              onChange={(blockedBy) => onChange({ ...draft, blockedBy })}
              ariaLabel={t("questions.stillWaits.blockedBy")}
              single
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
  const t = useCopy();
  const label = useLabel();
  const current = currentRoundOf(question);
  const answerable = isAnswerable(question);
  const outcome = outcomeOf(t, question);
  const earlier = earlierRoundsOf(question);
  const hidden = earlier.length === 0 ? roundCountOf(question) - 1 : 0;
  const firstEnabledId = answerable ? (question.options.find((o) => !o.locked)?.id ?? null) : null;
  const [wait, setWait] = useState<WaitDraft>(NO_WAIT);
  const [waitFault, setWaitFault] = useState<string | null>(null);
  const holds = answerable && question.issueId !== null;
  const hold = holdLine(t, current?.hold);
  const resume = resumeLine(t, label, current?.resume);

  const send = (round: number, given: GivenAnswer) => {
    if (holds && wait.on && !wait.reason.trim()) {
      setWaitFault(t("questions.stillWaits.fault"));
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
          {answerable ? t("questions.title.waiting") : t("questions.title.plain")}
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
            {hidden === 1 ? t("questions.earlier.one") : t("questions.earlier.many", { count: hidden })}
            {question.issueId
              ? hidden === 1
                ? t("questions.earlier.openIssueOne")
                : t("questions.earlier.openIssueMany")
              : t("questions.earlier.notInQueue")}
          </p>
        )}

        {current && (
          <div className="space-y-2">
            <p className="fg-caption text-subtle">{t("questions.round", { round: current.round })}</p>
            {current.prompt && <p className="fg-body text-fg">{current.prompt}</p>}
            {holds && <StillWaitsFields projectId={question.projectId} draft={wait} fault={waitFault} onChange={setWait} />}
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
              question.needed && <p className="fg-caption text-muted">{t("questions.needed", { needed: question.needed })}</p>
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
