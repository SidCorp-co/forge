"use client";

import { useState } from "react";
import { Button, enumLabel, Input, LEGEND, Radio, RadioGroup, Textarea, RefusalLine } from "@/design";
import type { SuggestionView } from "@/features/suggestions/types";
import { useSuggestionDecision, useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useFeedbackAction } from "../hooks";
import type { FeedbackDedup, FeedbackRouteWrite, FeedbackTriage, FeedbackView } from "../types";

type Choice = "link_issue" | "file_issue" | "master_issue" | "revision" | "new_requirement" | "answer" | "duplicate" | "decline";

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: "file_issue", label: "Bug: file a draft issue", hint: "A master picks it up once it is accepted as work." },
  { value: "link_issue", label: "Bug: link an issue", hint: "An issue already carries it." },
  { value: "master_issue", label: "Bug: leave the issue to the project master", hint: "Its case waits on the master to create or link one." },
  { value: "revision", label: "Scope change: revise the requirement", hint: "Name the revision proposal, or leave it to the BA." },
  { value: "new_requirement", label: "Out of scope: start a requirement", hint: "A new draft requirement carries it." },
  { value: "answer", label: "Question: answer it", hint: "The reporter reads the answer; it resolves the item." },
  { value: "duplicate", label: "Duplicate of an item", hint: "It follows its root from here." },
  { value: "decline", label: "Decline", hint: "A reason is required; the reporter reads it." },
];

const OPTIONAL: readonly Choice[] = ["file_issue", "master_issue", "revision"];

function TriageForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [choice, setChoice] = useState<Choice>("file_issue");
  const [text, setText] = useState("");
  const needsText = !OPTIONAL.includes(choice);
  const submit = () => {
    const value = text.trim();
    const triage: FeedbackTriage =
      choice === "file_issue"
        ? { route: "issue", createIssue: value ? { title: value } : {} }
        : choice === "link_issue"
          ? { route: "issue", issue: value }
          : choice === "master_issue"
            ? { route: "issue" }
            : choice === "revision"
              ? value
                ? { route: "revision", suggestion: value }
                : { route: "revision" }
              : choice === "new_requirement"
                ? { route: "new_requirement", title: value }
                : choice === "answer"
                  ? { route: "answer", answer: value }
                  : choice === "decline"
                    ? { route: "decline", note: value }
                    : { route: "duplicate", duplicateOf: value };
    act.mutate({ kind: "triage", triage });
  };
  const placeholder: Record<Choice, string> = {
    file_issue: "Issue title (optional; the item's title by default)",
    link_issue: "ISS-12",
    master_issue: "",
    revision: "Revision proposal id (optional)",
    new_requirement: "Requirement title",
    answer: "The answer the reporter reads",
    duplicate: "FB-3",
    decline: "Why it will not be done",
  };
  return (
    <section className="grid gap-3" data-testid="feedback-triage">
      <h3 className="text-12 font-semibold text-muted">Your triage</h3>
      <RadioGroup name={`triage-${f.key}`} value={choice} onChange={(v) => setChoice(v as Choice)} className="grid gap-2 sm:grid-cols-2">
        {CHOICES.map((c) => (
          <Radio
            key={c.value}
            value={c.value}
            label={
              <span className="grid">
                <span className="text-13 font-medium">{c.label}</span>
                <span className="text-12 text-muted">{c.hint}</span>
              </span>
            }
          />
        ))}
      </RadioGroup>
      {choice === "master_issue" ? null : choice === "answer" || choice === "decline" ? (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={placeholder[choice]} />
      ) : (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder[choice]} />
      )}
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={needsText && !text.trim()}
          onClick={submit}
        >
          {choice === "decline" ? "Decline" : "Route it"}
        </Button>
      </div>
    </section>
  );
}

const WRITE_FIELD: Record<string, { key: keyof FeedbackRouteWrite; placeholder: string }> = {
  issue: { key: "issue", placeholder: "ISS-12 to link (or leave empty to file a draft)" },
  revision: { key: "suggestion", placeholder: "Revision proposal id" },
  new_requirement: { key: "requirement", placeholder: "REQ-n of a draft requirement" },
  answer: { key: "answer", placeholder: "The answer the reporter reads" },
  duplicate: { key: "duplicateOf", placeholder: "FB-3" },
};

/** The case's owner writes what carries the route triage decided. */
function RouteForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [text, setText] = useState("");
  const c = f.case;
  const field = c ? WRITE_FIELD[c.route] : undefined;
  if (!c || !field) return null;
  const submit = () => {
    const value = text.trim();
    const write: FeedbackRouteWrite =
      c.route === "issue" && !value ? { createIssue: {} } : ({ [field.key]: value } as FeedbackRouteWrite);
    act.mutate({ kind: "route", write });
  };
  return (
    <section className="grid gap-3" data-testid="feedback-route">
      <h3 className="text-12 font-semibold text-muted">Write the route: {enumLabel("feedbackRoute", c.route)}</h3>
      {c.route === "answer" ? (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={field.placeholder} />
      ) : (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={field.placeholder} />
      )}
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={c.route !== "issue" && !text.trim()}
          onClick={submit}
        >
          Write the route
        </Button>
      </div>
    </section>
  );
}

function VerifyBar({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <section className="grid gap-2" data-testid="feedback-verify">
      <h3 className="text-12 font-semibold text-muted">Confirm the fix</h3>
      <p className="text-12 text-muted">Feedback is never verified automatically: the reporter, or a BA on their behalf, confirms it.</p>
      {reopening ? (
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="What the fix does not answer" />
      ) : null}
      <RefusalLine error={act.error} />
      <div className="flex gap-2">
        {reopening ? (
          <Button type="button" size="sm" variant="primary" disabled={!reason.trim()} loading={act.isPending} onClick={() => act.mutate({ kind: "reopen", reason: reason.trim() })}>
            Reopen
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ kind: "verify" })}>
              Mark verified
            </Button>
            <Button type="button" size="sm" onClick={() => setReopening(true)}>
              Reopen
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function RedactBar({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [sure, setSure] = useState(false);
  return (
    <div className="grid gap-2">
      <RefusalLine error={act.error} />
      <div className="flex items-center gap-2">
        {sure ? (
          <>
            <span className="text-12 text-muted">Deletes the text, attachments and embedding; the item stays as a tombstone.</span>
            <Button type="button" size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate({ kind: "redact" })}>
              Delete reporter data
            </Button>
          </>
        ) : (
          <button type="button" className="text-12 font-semibold text-muted hover:text-fg" onClick={() => setSure(true)}>
            Delete reporter data…
          </button>
        )}
      </div>
    </div>
  );
}

/** What a person can do now; the buttons follow the server's `can`, and a refusal still names why. */
export function FeedbackActions({ projectId, f }: { projectId: string; f: FeedbackView }) {
  return (
    <div className="grid gap-4">
      {f.can.route ? <RouteForm projectId={projectId} f={f} /> : null}
      {f.can.triage ? <TriageForm projectId={projectId} f={f} /> : null}
      {f.can.verify ? <VerifyBar projectId={projectId} f={f} /> : null}
      {f.can.redact ? <RedactBar projectId={projectId} f={f} /> : null}
    </div>
  );
}

function routeLine(s: SuggestionView): string {
  const t = (s.payload ?? {}) as Partial<FeedbackTriage>;
  const carrier = t.issue ?? t.duplicateOf ?? t.requirement ?? t.title ?? (t.createIssue ? "a draft issue" : "");
  return [t.route ? enumLabel("feedbackRoute", t.route) : "Route", carrier].filter(Boolean).join(" → ");
}

/** An assistant's triage suggestion is an accent bar an approver accepts or rejects, never an edit. */
export function Proposals({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const q = useWaitingSuggestions(projectId, { feedback: f.id }, f.openSuggestions > 0);
  const decide = useSuggestionDecision(projectId, [["feedback", projectId], ["feedback-item", projectId]]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const rows = q.data?.suggestions ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="feedback-proposals">
      {rows.map((s) => {
        const note = (s.payload as { note?: string } | null)?.note;
        const dedup = (s.payload as { dedup?: FeedbackDedup } | null)?.dedup;
        return (
          <div key={s.id} className="grid gap-1.5 py-1 pl-3" style={{ borderLeft: `3px solid ${LEGEND.run.dot}` }}>
            <span className="text-12 font-semibold" style={{ color: LEGEND.run.fg }}>
              Suggested triage · {s.producerKind === "person" ? "a person" : "an agent"}
            </span>
            <span className="text-13">{routeLine(s)}</span>
            {note ? <span className="text-12 text-muted">{note}</span> : null}
            {dedup ? (
              <span className="text-12 text-muted">
                {!dedup.ran
                  ? (dedup.why ?? "Triage without dedup")
                  : dedup.nearest
                    ? `Nearest item: ${dedup.nearest}${dedup.similarity !== undefined ? ` (${dedup.similarity})` : ""}`
                    : "No similar item found"}
              </span>
            ) : null}
            {f.can.triage ? (
              rejecting === s.id ? (
                <span className="flex gap-2">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not" />
                  <Button type="button" size="sm" disabled={!reason.trim()} onClick={() => decide.mutate({ kind: "reject", id: s.id, reason: reason.trim() })}>
                    Reject
                  </Button>
                </span>
              ) : (
                <span className="flex gap-2">
                  <Button type="button" size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ kind: "accept", id: s.id })}>
                    Accept
                  </Button>
                  <Button type="button" size="sm" onClick={() => setRejecting(s.id)}>
                    Reject
                  </Button>
                </span>
              )
            ) : null}
          </div>
        );
      })}
      <RefusalLine error={decide.error} />
    </section>
  );
}
