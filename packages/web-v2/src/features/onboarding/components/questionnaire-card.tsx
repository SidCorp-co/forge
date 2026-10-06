"use client";

// The questionnaire: one structured message answered inline and sent once (workflow
// project-onboarding, BC-6 / BC-7). The same card serves the onboarding thread and a BA requirement
// room; which thread it sits in decides nothing here. Once sent it collapses into the person's
// answers message (QuestionnaireSummary); a skipped batch folds to one line that can still be answered.

import { scrubsOnWrite } from "@forge/contracts/data-policy";
import {
  QUESTIONNAIRE_GROUP_LABELS,
  QUESTIONNAIRE_GROUPS,
  type QuestionnaireAnswer,
} from "@forge/contracts/onboarding";
import { useState } from "react";
import { Button } from "@/design";
import { refusalsOf } from "@/lib/api/refusals";
import { formatApiError } from "@/lib/api/error";
import { useSubmitAnswers } from "../hooks";
import type { DraftAnswers, QuestionnaireItemView, QuestionnaireView } from "../types";
import { AiMark, HoverNote, ToneChip } from "./marks";

const answered = (a: DraftAnswers[string] | undefined) =>
  a !== undefined &&
  ((a.text !== undefined && a.text.trim() !== "") ||
    a.choice !== undefined ||
    a.decision !== undefined ||
    (a.choices !== undefined && a.choices.length > 0));

function WhyWeAsk({ item, designTitle }: { item: QuestionnaireItemView; designTitle: (ref: string) => string }) {
  return (
    <HoverNote label="Why we ask" className="ml-1 text-[11px] font-normal text-subtle">
      <span>{item.why}</span>
      <br />
      <span className="opacity-70">Evidence</span>{" "}
      {item.evidence.map((e) => (
        <code key={e} className="mr-1 font-mono text-[10.5px]">
          {e}
        </code>
      ))}
      {item.affects.length > 0 && (
        <>
          <br />
          <span className="opacity-70">Shapes</span> {item.affects.map(designTitle).join(", ")}
        </>
      )}
    </HoverNote>
  );
}

function Chip({
  on,
  label,
  inferred,
  multi,
  onClick,
}: {
  on: boolean;
  label: string;
  inferred: boolean;
  multi?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      {...(multi ? { role: "checkbox", "aria-checked": on } : { role: "radio", "aria-checked": on })}
      onClick={onClick}
      className={`inline-flex min-h-7 max-w-full items-center gap-[5px] rounded-pill border px-2.5 py-[3px] text-left text-[12px] font-medium text-fg transition-colors ${
        on ? "border-[color:var(--link)] bg-[color:var(--sel-bg)]" : "border-line bg-surface hover:border-line-strong"
      }`}
    >
      <span
        aria-hidden
        className={`grid size-[11px] flex-none place-items-center border-[1.5px] ${multi ? "rounded-[3px]" : "rounded-full"} ${
          on ? "border-[color:var(--link)]" : "border-line-strong"
        }`}
      >
        {on && <span className={`size-[5px] bg-[color:var(--link)] ${multi ? "rounded-[1px]" : "rounded-full"}`} />}
      </span>
      <span className="min-w-0">{label}</span>
      {inferred && <AiMark title="Inferred from the code; not chosen until you pick it">Inferred</AiMark>}
    </button>
  );
}

function Control({
  item,
  value,
  onChange,
}: {
  item: QuestionnaireItemView;
  value: DraftAnswers[string] | undefined;
  onChange: (v: DraftAnswers[string] | undefined) => void;
}) {
  if (item.control === "choice" || item.control === "multi") {
    const multi = item.control === "multi";
    const picked = new Set(multi ? (value?.choices ?? []) : value?.choice ? [value.choice] : []);
    return (
      <div
        className="mt-1.5 flex flex-wrap gap-1.5"
        {...(multi ? { role: "group" } : { role: "radiogroup" })}
        {...{ "aria-label": item.prompt }}
      >
        {(item.options ?? []).map((o) => (
          <Chip
            key={o.id}
            multi={multi}
            on={picked.has(o.id)}
            label={o.label}
            inferred={item.inferredDefault === o.id}
            onClick={() => {
              if (!multi) return onChange(picked.has(o.id) ? undefined : { choice: o.id });
              const next = new Set(picked);
              if (next.has(o.id)) next.delete(o.id);
              else next.add(o.id);
              onChange(next.size ? { choices: [...next] } : undefined);
            }}
          />
        ))}
      </div>
    );
  }
  if (item.control === "accept_reject") {
    const d = value?.decision;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={d === "accept"}
          onClick={() => onChange(d === "accept" ? undefined : { decision: "accept" })}
          className={`h-7 rounded-md border px-2.5 text-[12px] font-semibold transition-colors ${
            d === "accept"
              ? "border-[color:var(--ai-bar)] bg-[color:var(--ai-bg)] text-[color:var(--ai-fg)]"
              : "border-[color:color-mix(in_srgb,var(--ai-bar)_55%,transparent)] bg-surface text-[color:var(--ai-fg)]"
          }`}
        >
          Accept
        </button>
        <button
          type="button"
          aria-pressed={d === "reject"}
          onClick={() => onChange(d === "reject" ? undefined : { decision: "reject" })}
          className={`h-7 rounded-md border px-2.5 text-[12px] font-semibold text-fg transition-colors ${
            d === "reject" ? "border-line-strong bg-sunken" : "border-line bg-surface"
          }`}
        >
          Reject
        </button>
        {d === "accept" && (
          <HoverNote label="Becomes a suggestion" className="text-[11.5px] text-muted">
            Nothing changes until an approver approves it.
          </HoverNote>
        )}
        {d === "reject" && <span className="text-[11.5px] text-muted">Will not be suggested again</span>}
      </div>
    );
  }
  return (
    <div className="mt-1.5">
      <input
        type="text"
        maxLength={280}
        aria-label={item.prompt}
        placeholder={item.placeholder ?? "A sentence or two is enough"}
        value={value?.text ?? ""}
        onChange={(e) => onChange(e.target.value ? { text: e.target.value } : undefined)}
        className="h-8 w-full rounded-sm border border-line bg-surface px-2.5 text-[12.5px] text-fg placeholder:text-subtle focus:border-[color:var(--link)] focus:outline-none"
      />
    </div>
  );
}

function Counter({ n, of, ids, done }: { n: number; of: number; ids: string[]; done: (id: string) => boolean }) {
  return (
    <HoverNote label={
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted no-underline">
        Answered{" "}
        <b className="font-semibold tabular-nums text-fg">
          {n} of {of}
        </b>
        <span aria-hidden className="inline-flex gap-[2px]">
          {ids.map((id) => (
            <i
              key={id}
              className={`block h-[5px] w-[7px] rounded-[2px] ${done(id) ? "bg-[color:var(--green-500)]" : "bg-[color:var(--paper-300)]"}`}
            />
          ))}
        </span>
      </span>
    }>
      Send any time. Unanswered items stay open and come back in the next round.
    </HoverNote>
  );
}

export function QuestionnaireCard({
  projectId,
  batch,
  designTitle = (r) => r,
}: {
  projectId: string;
  batch: QuestionnaireView;
  designTitle?: (ref: string) => string;
}) {
  const [draft, setDraft] = useState<DraftAnswers>({});
  const [resumed, setResumed] = useState(false);
  const submit = useSubmitAnswers(projectId, batch.conversationId);
  const open = batch.items.filter((i) => i.state === "open");
  const ids = open.map((i) => i.id);
  const n = ids.filter((id) => answered(draft[id])).length;

  if (batch.status === "skipped" && !resumed) {
    return (
      <div className="mt-1.5 border-l-[3px] border-line-strong bg-sunken" data-testid="questionnaire-skipped">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 py-2 pl-[11px] pr-3">
          <span className="text-[13px] font-bold text-fg">Skipped for now</span>
          <span className="text-[11.5px] text-subtle">Open {open.length}</span>
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => setResumed(true)}>
            Answer now
          </Button>
        </div>
      </div>
    );
  }

  const send = (skip: boolean) => {
    const answers: QuestionnaireAnswer[] = skip
      ? []
      : ids.filter((id) => answered(draft[id])).map((id) => ({ itemId: id, ...draft[id] }));
    submit.mutate({ batchId: batch.id, answers, skip });
  };
  const error = submit.error
    ? (refusalsOf(submit.error)[0]?.detail ?? formatApiError(submit.error))
    : null;

  let num = 0;
  return (
    <form
      aria-label={batch.title}
      data-testid="questionnaire-card"
      onSubmit={(e) => e.preventDefault()}
      className="mt-1.5 border-l-[3px] border-[color:var(--ai-bar)] bg-surface"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5 py-2 pl-[11px] pr-3">
        <span className="text-[13px] font-bold text-fg">{batch.title}</span>
        <span className="text-[11.5px] text-subtle">
          <HoverNote label={`Round ${batch.round} of ${batch.maxRounds}`}>
            At most {batch.maxRounds} rounds. After the last, open items stay listed on their designs as open questions.
          </HoverNote>
        </span>
      </div>
      {/* on a redact or no_egress project the answers reach the agent (scrubbed): the owner's
          2026-10-04 ruling holds them to product information, and the card says so where they are typed */}
      {scrubsOnWrite(batch.sensitiveData) && (
        <p data-testid="questionnaire-data-warning" className="border-t border-line-subtle py-1.5 pl-[11px] pr-3 text-[11.5px] text-muted">
          Answers are product information. Do not include patient data.
        </p>
      )}
      {QUESTIONNAIRE_GROUPS.map((g) => {
        const mine = open.filter((i) => i.group === g);
        if (mine.length === 0) return null;
        return (
          <div key={g}>
            <div className="flex items-baseline gap-2 bg-sunken py-1 pl-[11px] pr-3 text-[12px] font-bold text-fg">
              {QUESTIONNAIRE_GROUP_LABELS[g]}
              <span className="font-mono text-[10.5px] font-semibold text-subtle">{mine.length}</span>
            </div>
            {mine.map((item) => {
              num += 1;
              return (
                <div key={item.id} className="border-b border-line-subtle pb-2.5 pl-[11px] pr-3 pt-2 last:border-b-0">
                  <div className="flex items-baseline gap-2 text-[12.5px] font-medium text-fg">
                    <span className="flex-none font-mono text-[10.5px] font-semibold text-subtle">{num}</span>
                    <span className="min-w-0">
                      {item.prompt}{" "}
                      {item.isNew && <ToneChip tone="run" label="New" />}
                      <WhyWeAsk item={item} designTitle={designTitle} />
                    </span>
                  </div>
                  <Control
                    item={item}
                    value={draft[item.id]}
                    onChange={(v) =>
                      setDraft((d) => {
                        const next = { ...d };
                        if (v) next[item.id] = v;
                        else delete next[item.id];
                        return next;
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="border-t border-line-subtle px-3 py-2 text-[12px] text-[color:var(--red-600)]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line-subtle pb-2.5 pl-[11px] pr-3 pt-2">
        <Counter n={n} of={ids.length} ids={ids} done={(id) => answered(draft[id])} />
        <span className="flex-1" />
        {batch.status === "open" && (
          <Button size="sm" variant="secondary" disabled={submit.isPending} onClick={() => send(true)}>
            Skip for now
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={n === 0 || submit.isPending} onClick={() => send(false)}>
          Send answers
        </Button>
      </div>
    </form>
  );
}

function answerLabel(item: QuestionnaireItemView) {
  const a = item.answer;
  if (item.state !== "answered" || !a) return <ToneChip tone="you" label="Open" />;
  if (a.decision) return <ToneChip tone="done" label={a.decision === "accept" ? "Accepted" : "Rejected"} />;
  const label = (id: string) => item.options?.find((o) => o.id === id)?.label ?? id;
  if (a.text !== undefined)
    return <span className="min-w-0 truncate font-medium text-fg">“{a.text}”</span>;
  const text = a.choices ? a.choices.map(label).join(", ") : label(a.choice ?? "");
  return (
    <>
      <span className="min-w-0 truncate font-medium text-fg">{text}</span>
      {a.choice && a.choice === item.inferredDefault && (
        <span className="text-[11px] text-subtle" title="As inferred from the code">
          ✓
        </span>
      )}
    </>
  );
}

/** The answers message: the card, collapsed to what was sent and what stayed open. */
export function QuestionnaireSummary({ batch }: { batch: QuestionnaireView }) {
  const items = batch.items;
  const answeredHere = items.filter((i) => i.state === "answered").length;
  const openHere = items.length - answeredHere;
  return (
    <div className="mt-1" data-testid="questionnaire-summary">
      <div className="mb-0.5 text-[11.5px] text-subtle">
        {batch.title} · Round {batch.round} · Answered {answeredHere} of {items.length}
        {openHere ? ` · Open ${openHere}` : ""}
      </div>
      {items.map((i) => (
        <div key={i.id} className="flex min-w-0 items-center gap-2 border-t border-line-subtle py-[3px] text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-muted" title={i.prompt}>
            {i.prompt}
          </span>
          <span className="flex min-w-0 max-w-[56%] flex-none items-center justify-end gap-[5px]">{answerLabel(i)}</span>
        </div>
      ))}
    </div>
  );
}
