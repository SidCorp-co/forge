"use client";

// One `agent_questions` row, rendered wherever it is reached from — the issue's
// own panel and the project-wide queue on the Agents screen.
//
// The card owns the rules that make an irreversible submit safe, and it owns
// them BECAUSE it is shared: whoever mounts it supplies only a way to send and a
// pending flag, so neither caller can reconstruct a round or re-derive a lock.

import type { AnswerHold, AnswerResume } from "@forge/contracts/questions";
import { useState } from "react";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { type Copy, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { statusReading } from "@/design/vocabulary";
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
  const t = useCopy();
  return (
    <div className="border-t border-line-subtle py-2.5">
      <div className="flex flex-wrap items-start gap-2">
        <span className="fg-body-sm min-w-0 flex-1 text-fg">{option.label}</span>
        {recommended && <Badge tone="accent">{t("agents.question.recommended")}</Badge>}
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
    return (
      <p className="fg-caption text-danger">
        {t("agents.question.lockedText")}
      </p>
    );
  }

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

function isAnswerable(question: AgentQuestion): boolean {
  return question.status === "open" && question.blockerKind === "human";
}

function answeredWith(last: QuestionStep | undefined, t: Copy): string {
  if (!last) return t("agents.question.noRound");
  if (!isChoiceStep(last)) return last.answerText ?? t("agents.question.inWords");
  return (
    last.options.find((o) => o.id === last.chosenOptionId)?.label ??
    last.chosenOptionId ??
    t("agents.question.optionGone")
  );
}

export function outcomeOf(question: AgentQuestion, language = "en"): string | null {
  const t = productCopy(language);
  const last = currentRoundOf(question);
  if (question.status === "answered") {
    return t("agents.question.outcome.answered", { what: answeredWith(last, t) });
  }
  if (question.status === "void") {
    return t("agents.question.outcome.void", { why: question.voidReason ?? t("agents.question.noReason") });
  }
  if (question.status === "expired") {
    return t("agents.question.outcome.expired", { why: question.endedReason ?? t("agents.question.deadlinePassed") });
  }
  if (question.status === "needs_info") {
    return t("agents.question.outcome.needsInfo");
  }
  return null;
}

/** What the answer said the issue still waits on, as the answered card shows it. */
function holdLine(hold: AnswerHold | undefined, t: Copy): string | null {
  if (!hold) return null;
  return hold.blockedBy
    ? t("agents.question.stillWaitsOn", { key: hold.blockedBy.key, reason: hold.reason })
    : t("agents.question.stillWaits", { reason: hold.reason });
}

/** What the answer did to the issue it stopped, in a reader's words; null until core recorded it. */
function resumeLine(resume: AnswerResume | undefined, t: Copy, language: string): string | null {
  switch (resume?.kind) {
    case undefined:
      return null;
    case "resumed":
      return t("agents.question.resume.resumed", { to: statusReading("issue", resume.to, language).label });
    case "sent_to_run":
      return t("agents.question.resume.sent_to_run");
    case "box_reads":
      return t("agents.question.resume.box_reads");
    case "other_question":
      return t("agents.question.resume.other_question");
    case "held":
      return t("agents.question.resume.held");
    case "no_left_status":
      return t("agents.question.resume.no_left_status");
    case "staged":
      return t("agents.question.resume.staged");
    case "refused":
      return t("agents.question.resume.refused", { code: resume.code, detail: resume.detail });
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
          <Field label={t("agents.question.blockedBy")} hint={t("agents.question.blockedByHint")}>
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
  const language = useInterfaceLanguage();
  const current = currentRoundOf(question);
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
          {answerable ? t("agents.question.waiting") : t("agents.question.decision")}
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
      </PageSectionBody>
    </PageSection>
  );
}
