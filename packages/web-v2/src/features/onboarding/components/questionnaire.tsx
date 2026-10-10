"use client";

// The questionnaire: one structured message answered inline and sent once (workflow
// project-onboarding, BC-6 / BC-7). The same form serves the onboarding thread and a BA requirement
// room; which thread it sits in decides nothing here. Once sent it collapses into the person's
// answers message (QuestionnaireSummary); a skipped batch folds to one line that can still be answered.

import { scrubsOnWrite } from "@forge/contracts/data-policy";
import { QUESTIONNAIRE_GROUP_LABELS, QUESTIONNAIRE_GROUPS, type QuestionnaireAnswer } from "@forge/contracts/onboarding";
import { useState } from "react";
import { Button, ChoiceChips, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useSubmitAnswers } from "../hooks";
import type { DraftAnswers, QuestionnaireItemView, QuestionnaireView } from "../types";
import { AiMark, HoverNote, ToneChip } from "./marks";

type Draft = DraftAnswers[string] | undefined;

const answered = (a: Draft) =>
  a !== undefined &&
  ((a.text !== undefined && a.text.trim() !== "") || a.choice !== undefined || a.decision !== undefined || (a.choices !== undefined && a.choices.length > 0));

function WhyWeAsk({ item, designTitle }: { item: QuestionnaireItemView; designTitle: (ref: string) => string }) {
  const t = useCopy();
  return (
    <HoverNote label={t("onboarding.q.whyWeAsk")} className="ml-1 text-12 font-normal text-subtle">
      <span>{item.why}</span>
      <br />
      <span className="text-muted">{t("onboarding.q.evidence")}</span>{" "}
      {item.evidence.map((e) => (
        <code key={e} className="mr-1 font-mono text-12">
          {e}
        </code>
      ))}
      {item.affects.length > 0 && (
        <>
          <br />
          <span className="text-muted">{t("onboarding.q.shapes")}</span> {item.affects.map(designTitle).join(", ")}
        </>
      )}
    </HoverNote>
  );
}

/** The control an item asks for: chips for a choice, accept or reject on a proposal, else a line of text. */
function Control({ item, value, onChange }: { item: QuestionnaireItemView; value: Draft; onChange: (v: Draft) => void }) {
  const t = useCopy();
  if (item.control === "choice" || item.control === "multi") {
    const multi = item.control === "multi";
    return (
      <ChoiceChips
        className="mt-1.5"
        label={item.prompt}
        multiple={multi}
        value={multi ? (value?.choices ?? []) : value?.choice ? [value.choice] : []}
        onChange={(next) => onChange(next.length === 0 ? undefined : multi ? { choices: next } : { choice: next[0] })}
        options={(item.options ?? []).map((o) => ({
          value: o.id,
          label: o.label,
          mark: item.inferredDefault === o.id ? <AiMark>{t("onboarding.q.inferred")}</AiMark> : undefined,
        }))}
      />
    );
  }
  if (item.control === "accept_reject") {
    return (
      <ChoiceChips
        className="mt-1.5"
        label={item.prompt}
        tone="ai"
        value={value?.decision ? [value.decision] : []}
        onChange={(next) => onChange(next[0] ? { decision: next[0] as "accept" | "reject" } : undefined)}
        options={[
          { value: "accept", label: t("onboarding.q.accept") },
          { value: "reject", label: t("onboarding.q.reject") },
        ]}
      />
    );
  }
  return (
    <Input
      className="mt-1.5"
      maxLength={280}
      aria-label={item.prompt}
      placeholder={item.placeholder ?? t("onboarding.q.yourAnswer")}
      value={value?.text ?? ""}
      onChange={(e) => onChange(e.target.value ? { text: e.target.value } : undefined)}
    />
  );
}

function Counter({ ids, done }: { ids: string[]; done: (id: string) => boolean }) {
  const t = useCopy();
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-muted">
      {t("onboarding.q.answered", { n: ids.filter(done).length, of: ids.length })}
      <span aria-hidden className="inline-flex gap-0.5">
        {ids.map((id) => (
          <i key={id} className={cn("block h-1.25 w-1.75 rounded-xs", done(id) ? "bg-ok-9" : "bg-neutral-7")} />
        ))}
      </span>
    </span>
  );
}

export function Questionnaire({ projectId, batch, designTitle = (r) => r }: { projectId: string; batch: QuestionnaireView; designTitle?: (ref: string) => string }) {
  const t = useCopy();
  const [draft, setDraft] = useState<DraftAnswers>({});
  const [resumed, setResumed] = useState(false);
  const submit = useSubmitAnswers(projectId, batch.conversationId);
  const open = batch.items.filter((i) => i.state === "open");
  const ids = open.map((i) => i.id);
  const done = (id: string) => answered(draft[id]);

  if (batch.status === "skipped" && !resumed) {
    return (
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 border-l-3 border-line-strong bg-sunken py-2 pr-3 pl-3" data-testid="questionnaire-skipped">
        <span className="text-13 font-bold text-fg">{t("onboarding.q.skipped")}</span>
        <span className="text-12 text-subtle">{t("onboarding.q.open", { n: open.length })}</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setResumed(true)}>
          {t("onboarding.q.answerNow")}
        </Button>
      </div>
    );
  }

  const send = (skip: boolean) => {
    const answers: QuestionnaireAnswer[] = skip ? [] : ids.filter(done).map((id) => ({ itemId: id, ...draft[id] }));
    submit.mutate({ batchId: batch.id, answers, skip });
  };
  const setAnswer = (id: string, v: Draft) =>
    setDraft((d) => {
      const { [id]: _, ...rest } = d;
      return v ? { ...rest, [id]: v } : rest;
    });

  let num = 0;
  return (
    <form aria-label={batch.title} data-testid="questionnaire-card" onSubmit={(e) => e.preventDefault()} className="mt-1.5 border-l-3 border-ai-9 bg-surface">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 py-2 pr-3 pl-3">
        <span className="text-13 font-bold text-fg">{batch.title}</span>
        <span className="text-12 text-subtle">{t("onboarding.q.round", { round: batch.round, max: batch.maxRounds })}</span>
      </div>
      {/* on a redact or no_egress project the answers reach the agent (scrubbed): the owner's
          2026-10-04 ruling holds them to product information, and the form says so where they are typed */}
      {scrubsOnWrite(batch.sensitiveData) && (
        <p data-testid="questionnaire-data-warning" className="border-t border-line-subtle py-1.5 pr-3 pl-3 text-12 text-muted">
          {t("onboarding.q.dataWarning")}
        </p>
      )}
      {QUESTIONNAIRE_GROUPS.map((g) => {
        const mine = open.filter((i) => i.group === g);
        if (mine.length === 0) return null;
        return (
          <div key={g}>
            <div className="flex items-baseline gap-2 bg-sunken py-1 pr-3 pl-3 text-12 font-bold text-fg">
              {QUESTIONNAIRE_GROUP_LABELS[g]}
              <span className="font-mono text-12 font-semibold text-subtle">{mine.length}</span>
            </div>
            {mine.map((item) => {
              num += 1;
              return (
                <div key={item.id} className="border-b border-line-subtle pt-2 pr-3 pb-2.5 pl-3 last:border-b-0">
                  <div className="flex items-baseline gap-2 text-13 font-medium text-fg">
                    <span className="flex-none font-mono text-12 font-semibold text-subtle">{num}</span>
                    <span className="min-w-0">
                      {item.prompt} {item.isNew && <ToneChip tone="run" label={t("onboarding.q.new")} />}
                      <WhyWeAsk item={item} designTitle={designTitle} />
                    </span>
                  </div>
                  <Control item={item} value={draft[item.id]} onChange={(v) => setAnswer(item.id, v)} />
                </div>
              );
            })}
          </div>
        );
      })}
      <RefusalLine error={submit.error} testid="questionnaire-refusal" />
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line-subtle pt-2 pr-3 pb-2.5 pl-3">
        <Counter ids={ids} done={done} />
        <span className="flex-1" />
        {batch.status === "open" && (
          <Button size="sm" variant="secondary" disabled={submit.isPending} onClick={() => send(true)}>
            {t("onboarding.q.skip")}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!ids.some(done) || submit.isPending} onClick={() => send(false)}>
          {t("onboarding.q.send")}
        </Button>
      </div>
    </form>
  );
}

function AnswerLabel({ item }: { item: QuestionnaireItemView }) {
  const t = useCopy();
  const a = item.answer;
  if (item.state !== "answered" || !a) return <ToneChip tone="you" label={t("onboarding.q.openMark")} />;
  if (a.decision) return <ToneChip tone="done" label={t(a.decision === "accept" ? "onboarding.q.accepted" : "onboarding.q.rejected")} />;
  if (a.text !== undefined) return <span className="min-w-0 truncate font-medium text-fg">“{a.text}”</span>;
  const label = (id: string) => item.options?.find((o) => o.id === id)?.label ?? id;
  return (
    <>
      <span className="min-w-0 truncate font-medium text-fg">{a.choices ? a.choices.map(label).join(", ") : label(a.choice ?? "")}</span>
      {a.choice && a.choice === item.inferredDefault && (
        <span className="text-12 text-subtle" title={t("onboarding.q.asInferred")}>
          ✓
        </span>
      )}
    </>
  );
}

/** The answers message: the form, collapsed to what was sent and what stayed open. */
export function QuestionnaireSummary({ batch }: { batch: QuestionnaireView }) {
  const t = useCopy();
  const items = batch.items;
  const answeredHere = items.filter((i) => i.state === "answered").length;
  const openHere = items.length - answeredHere;
  return (
    <div className="mt-1" data-testid="questionnaire-summary">
      <div className="mb-0.5 text-12 text-subtle">
        {t("onboarding.q.summary", { title: batch.title, round: batch.round, n: answeredHere, of: items.length })}
        {openHere ? t("onboarding.q.summaryOpen", { n: openHere }) : ""}
      </div>
      {items.map((i) => (
        <div key={i.id} className="flex min-w-0 items-center gap-2 border-t border-line-subtle py-0.75 text-13">
          <span className="min-w-0 flex-1 truncate text-muted" title={i.prompt}>
            {i.prompt}
          </span>
          <span className="flex min-w-0 max-w-1/2 flex-none items-center justify-end gap-1.25">
            <AnswerLabel item={i} />
          </span>
        </div>
      ))}
    </div>
  );
}
