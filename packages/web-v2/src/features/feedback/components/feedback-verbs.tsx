"use client";

// The four verbs of triage on a new item, flat and inline (feedback-triage `decide`): Accept, Decline,
// Duplicate of, Snooze. Each opens one short form that says what the act tells the reporter; a refusal
// names why and keeps what was typed. Core's `can.accept` decides whether they are offered.

import { useId, useMemo, useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useFeedbackChoices, useFeedbackAction, useFeedbackList } from "../hooks";
import type { FeedbackView } from "../types";
import { choiceOf } from "./target-picker";

type Verb = "accept" | "decline" | "duplicate" | "snooze";

const VERBS: { verb: Verb; label: string; hint: string }[] = [
  { verb: "accept", label: "Accept", hint: "It is a real report; route it to work next." },
  { verb: "decline", label: "Decline", hint: "It will not be done; the reporter is told why." },
  { verb: "duplicate", label: "Duplicate of…", hint: "Another item already carries it." },
  { verb: "snooze", label: "Snooze…", hint: "Look at it again on a date." },
];

/** The day after today as `YYYY-MM-DD`, the earliest a snooze may end. */
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** A snooze ends at 09:00 local on the day picked, as the instant core is sent. */
export const snoozeUntil = (day: string) => new Date(`${day}T09:00:00`).toISOString();

function AcceptForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const act = useFeedbackAction(projectId, f.key);
  const listId = useId();
  const choices = useFeedbackChoices(projectId, "requirement").data ?? [];
  const [text, setText] = useState("");
  const picked = choiceOf(choices, text);
  const unmatched = text.trim() !== "" && !picked;
  return (
    <div className="grid gap-2">
      <Field label="About a requirement (optional)" hint="Link it to the requirement it is about, by title; leave it empty to accept it as it stands.">
        <Input aria-label="Requirement" value={text} onChange={(e) => setText(e.target.value)} list={choices.length ? listId : undefined} placeholder="Search requirements by title" />
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
          {`No requirement of this project is titled or keyed “${text.trim()}”: pick one from the list.`}
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
          Accept
        </Button>
      </div>
    </div>
  );
}

function DeclineForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const act = useFeedbackAction(projectId, f.key);
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-2">
      <Field label="Why it will not be done" hint="The reporter gets one notice with this reason, and the item leaves the funnel as declined.">
        <Textarea aria-label="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
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
          Decline
        </Button>
      </div>
    </div>
  );
}

function DuplicateForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const act = useFeedbackAction(projectId, f.key);
  const listId = useId();
  const list = useFeedbackList(projectId).data?.feedback ?? [];
  const choices = useMemo(() => list.filter((r) => r.key !== f.key && r.phase !== "declined").map((r) => ({ key: r.key, title: r.title })), [list, f.key]);
  const [text, setText] = useState("");
  const picked = choiceOf(choices, text);
  const unmatched = text.trim() !== "" && !picked;
  return (
    <div className="grid gap-2">
      <Field label="The original" hint="Pick it by title. Its reporter and evidence join the original, which keeps this record; its reporter is told which item carries it.">
        <Input aria-label="Original" value={text} onChange={(e) => setText(e.target.value)} list={choices.length ? listId : undefined} placeholder="Search feedback by title" />
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
          {`No open feedback item is titled or keyed “${text.trim()}”: pick one from the list.`}
        </span>
      ) : null}
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={!picked}
          onClick={() => act.mutate({ kind: "triage", triage: { route: "duplicate", duplicateOf: (picked as { key: string }).key } }, { onSuccess: done })}
        >
          Mark duplicate
        </Button>
      </div>
    </div>
  );
}

function SnoozeForm({ projectId, f, done }: { projectId: string; f: FeedbackView; done: () => void }) {
  const act = useFeedbackAction(projectId, f.key);
  const [day, setDay] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="grid gap-2">
      <Field label="Back in New on" hint="It leaves Needs you until then and returns by itself.">
        <Input aria-label="Until" type="date" min={tomorrow()} value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Field label="Why">
        <Input aria-label="Why snooze" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What you are waiting for" />
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
          Snooze
        </Button>
      </div>
    </div>
  );
}

/** Accept, Decline, Duplicate, Snooze: offered on an item still in New, as buttons that each open their one form. */
export function TriageVerbs({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const [verb, setVerb] = useState<Verb | null>(null);
  if (!f.can.accept) return null;
  const close = () => setVerb(null);
  return (
    <section className="grid gap-2" data-testid="feedback-verbs">
      <h3 className="text-12 font-semibold text-muted">Triage</h3>
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Triage verbs</legend>
        {VERBS.map((v) => (
          <Button key={v.verb} type="button" size="sm" variant={verb === v.verb ? "primary" : undefined} title={v.hint} aria-pressed={verb === v.verb} onClick={() => setVerb(verb === v.verb ? null : v.verb)}>
            {v.label}
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
