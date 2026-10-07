"use client";

// The four verbs of triage on a new item, flat and inline (feedback-triage `decide`): Accept, Decline,
// Duplicate of, Snooze. Each opens one short form that says what the act tells the reporter; a refusal
// names why and keeps what was typed. Core's `can.accept` decides whether they are offered.

import { useId, useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackChoices, useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";
import { type FeedbackPick, FeedbackPicker } from "./feedback-picker";
import { choiceOf } from "./target-picker";

type Verb = "accept" | "decline" | "duplicate" | "snooze";

const VERBS = ["accept", "decline", "duplicate", "snooze"] as const satisfies readonly Verb[];

/** The day after today as `YYYY-MM-DD`, the earliest a snooze may end. */
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** A snooze ends at 09:00 local on the day picked, as the instant core is sent. */
export const snoozeUntil = (day: string) => new Date(`${day}T09:00:00`).toISOString();

export function AcceptForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const listId = useId();
  const choices = useFeedbackChoices(projectId, "requirement").data ?? [];
  const [text, setText] = useState("");
  const picked = choiceOf(choices, text);
  const unmatched = text.trim() !== "" && !picked;
  return (
    <div className="grid gap-2">
      <Field label={t("feedback.accept.label")} hint={t("feedback.accept.hint")}>
        <Input aria-label={t("feedback.accept.aria")} value={text} onChange={(e) => setText(e.target.value)} list={choices.length ? listId : undefined} placeholder={t("feedback.accept.placeholder")} />
      </Field>
      {choices.length ? (
        <datalist id={listId}>
          {choices.map((c) => (
            <option key={c.key} value={c.title} label={c.key} />
          ))}
        </datalist>
      ) : null}
      {unmatched ? (
        <span className="text-12 text-danger" role="alert" data-testid="verb-unmatched">
          {t("feedback.accept.unmatched", { text: text.trim() })}
        </span>
      ) : null}
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={unmatched}
          onClick={() => act.mutate({ kind: "accept", ...(picked ? { requirement: picked.key } : {}) }, { onSuccess: done })}
        >
          {t("feedback.accept.go")}
        </Button>
      </div>
    </div>
  );
}

export function DeclineForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-2">
      <Field label={t("feedback.decline.label")} hint={t("feedback.decline.hint")}>
        <Textarea aria-label={t("feedback.decline.aria")} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={!reason.trim()}
          onClick={() => act.mutate({ kind: "triage", triage: { route: "decline", note: reason.trim() } }, { onSuccess: done })}
        >
          {t("feedback.decline.go")}
        </Button>
      </div>
    </div>
  );
}

export function DuplicateForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const fieldId = useId();
  const [picked, setPicked] = useState<FeedbackPick | null>(null);
  return (
    <div className="grid gap-2">
      <Field label={t("feedback.duplicate.label")} hint={t("feedback.duplicate.hint")} htmlFor={fieldId}>
        <FeedbackPicker id={fieldId} projectId={projectId} self={f.key} value={picked} onChange={setPicked} />
      </Field>
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={!picked}
          onClick={() => act.mutate({ kind: "triage", triage: { route: "duplicate", duplicateOf: (picked as FeedbackPick).key } }, { onSuccess: done })}
        >
          {t("feedback.duplicate.go")}
        </Button>
      </div>
    </div>
  );
}

export function SnoozeForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [day, setDay] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-2">
      <Field label={t("feedback.snooze.label")} hint={t("feedback.snooze.hint")}>
        <Input aria-label={t("feedback.snooze.untilAria")} type="date" min={tomorrow()} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Field label={t("feedback.snooze.why")}>
        <Input aria-label={t("feedback.snooze.whyAria")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("feedback.snooze.whyPlaceholder")} />
      </Field>
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={!day || !reason.trim()}
          onClick={() => act.mutate({ kind: "snooze", until: snoozeUntil(day), reason: reason.trim() }, { onSuccess: done })}
        >
          {t("feedback.snooze.go")}
        </Button>
      </div>
    </div>
  );
}

/** Accept, Decline, Duplicate, Snooze: offered on an item still in New, as buttons that each open their one form. */
export function TriageVerbs({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const [verb, setVerb] = useState<Verb | null>(null);
  if (!f.can.accept) return null;
  const close = () => setVerb(null);
  return (
    <section className="grid gap-2" data-testid="feedback-verbs">
      <h3 className="text-12 font-semibold text-muted">{t("feedback.verbs.heading")}</h3>
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">{t("feedback.verbs.legend")}</legend>
        {VERBS.map((v) => (
          <Button key={v} type="button" size="sm" variant={verb === v ? "primary" : undefined} title={t(`feedback.verb.${v}Hint`)} aria-pressed={verb === v} onClick={() => setVerb(verb === v ? null : v)}>
            {t(`feedback.verb.${v}`)}
          </Button>
        ))}
      </fieldset>
      {verb ? (
        <div className="border-t border-line-subtle pt-3" data-testid={`verb-${verb}`}>
          {verb === "accept" ? <AcceptForm projectId={projectId} f={f} done={close} /> : null}
          {verb === "decline" ? <DeclineForm projectId={projectId} f={f} done={close} /> : null}
          {verb === "duplicate" ? <DuplicateForm projectId={projectId} f={f} done={close} /> : null}
          {verb === "snooze" ? <SnoozeForm projectId={projectId} f={f} done={close} /> : null}
        </div>
      ) : null}
    </section>
  );
}
