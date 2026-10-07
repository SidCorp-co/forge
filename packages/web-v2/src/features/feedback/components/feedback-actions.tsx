"use client";

import { useState } from "react";
import { AcceptStep, Button, enumLabel, Input, LEGEND, Radio, RadioGroup, Textarea } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { formatStamp } from "@/lib/utils/format";
import type { SuggestionView } from "@/features/suggestions/types";
import { useSuggestionDecision, useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useFeedbackAction } from "../hooks";
import { RetargetForm } from "./feedback-retarget";
import { TriageVerbs } from "./feedback-verbs";
import type { FeedbackDedup, FeedbackTriage, FeedbackView } from "../types";

type Choice = "link_issue" | "file_issue" | "revision" | "new_requirement" | "answer" | "duplicate" | "decline";

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: "file_issue", label: "Bug: file a draft issue", hint: "A master picks it up once it is accepted as work." },
  { value: "link_issue", label: "Bug: link issues", hint: "One or more issues already carry it." },
  { value: "revision", label: "Scope change: revise the requirement", hint: "Name the revision proposal that carries it." },
  { value: "new_requirement", label: "Out of scope: start a requirement", hint: "A new draft requirement carries it." },
  { value: "answer", label: "Question: answer it", hint: "The reporter reads the answer; it resolves the item." },
  { value: "duplicate", label: "Duplicate of an item", hint: "It follows its root from here." },
  { value: "decline", label: "Decline", hint: "A reason is required; the reporter reads it." },
];

const OPTIONAL: readonly Choice[] = ["file_issue"];

/** The issues a person picked, by key: one stays one, several become a list. */
export function issueKeysOf(picked: readonly IssuePick[]): string | string[] {
  const keys = picked.map((p) => p.key);
  return keys.length === 1 ? (keys[0] as string) : keys;
}

function TriageForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const act = useFeedbackAction(projectId, f.key);
  const [choice, setChoice] = useState<Choice>("file_issue");
  const [text, setText] = useState("");
  const [linked, setLinked] = useState<IssuePick[]>([]);
  const needsText = !OPTIONAL.includes(choice);
  const missing = choice === "link_issue" ? linked.length === 0 : needsText && !text.trim();
  const submit = () => {
    const value = text.trim();
    const triage: FeedbackTriage =
      choice === "file_issue"
        ? { route: "issue", createIssue: value ? { title: value } : {} }
        : choice === "link_issue"
          ? { route: "issue", issue: issueKeysOf(linked) }
          : choice === "revision"
            ? { route: "revision", suggestion: value }
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
    link_issue: "",
    revision: "Revision proposal id",
    new_requirement: "Requirement title",
    answer: "The answer the reporter reads",
    duplicate: "FB-3",
    decline: "Why it will not be done",
  };
  return (
    <section className="grid gap-3" data-testid="feedback-triage">
      <h3 className="text-12 font-semibold text-muted">{f.can.accept ? "Or route it to work" : "Your triage"}</h3>
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
      {choice === "link_issue" ? (
        <IssuePicker projectId={projectId} value={linked} onChange={setLinked} ariaLabel="Issues that carry it" />
      ) : choice === "answer" || choice === "decline" ? (
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
          disabled={missing}
          onClick={submit}
        >
          {choice === "decline" ? "Decline" : "Route it"}
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
      <p className="text-12 text-muted" data-testid="verify-copy">
        Anyone on the project, or the reporter, may confirm the fix, and the record keeps who and when.
        {f.autoVerify ? ` If nobody does by ${formatStamp(f.autoVerify.at)}, Forge verifies it after ${f.autoVerify.windowDays} days with no reply.` : " If nobody does within the project’s verify window, Forge verifies it."}
      </p>
      {f.can.askVerify ? <p className="text-12 text-muted">Asking sends the item to the reporter, where it stays until it is verified or reopened.</p> : null}
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
            {f.can.verify ? (
              <Button type="button" size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ kind: "verify" })}>
                Mark verified
              </Button>
            ) : null}
            {f.can.askVerify ? (
              <Button type="button" size="sm" loading={act.isPending} onClick={() => act.mutate({ kind: "verify-ask" })}>
                Ask the reporter
              </Button>
            ) : null}
            {f.can.reopen ? (
              <Button type="button" size="sm" onClick={() => setReopening(true)}>
                Reopen
              </Button>
            ) : null}
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
      <TriageVerbs projectId={projectId} f={f} />
      {f.can.triage ? <TriageForm projectId={projectId} f={f} /> : null}
      {f.can.verify || f.can.reopen || f.can.askVerify ? <VerifyBar projectId={projectId} f={f} /> : null}
      {f.can.retarget ? <RetargetForm projectId={projectId} f={f} /> : null}
      {f.can.redact ? <RedactBar projectId={projectId} f={f} /> : null}
    </div>
  );
}

function routeLine(s: SuggestionView): string {
  const t = (s.payload ?? {}) as Partial<FeedbackTriage>;
  const carrier = (Array.isArray(t.issue) ? t.issue.join(", ") : t.issue) ?? t.duplicateOf ?? t.requirement ?? t.title ?? (t.createIssue ? "a draft issue" : "");
  return [t.route ? enumLabel("feedbackRoute", t.route) : "Route", carrier].filter(Boolean).join(" → ");
}

/** An assistant's triage suggestion is an accent bar an approver accepts (through the confirm step that takes
 *  their reason) or rejects with one, never an edit. */
export function Proposals({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const q = useWaitingSuggestions(projectId, { feedback: f.id }, f.openSuggestions > 0);
  const decide = useSuggestionDecision(projectId, [["feedback", projectId], ["feedback-item", projectId]]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
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
              accepting === s.id ? (
                <AcceptStep
                  confirmLabel="Accept"
                  consequence={`Accepting routes the item: ${routeLine(s)}.`}
                  loading={decide.isPending}
                  onCancel={() => setAccepting(null)}
                  onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, { onSuccess: () => setAccepting(null) })}
                />
              ) : rejecting === s.id ? (
                <span className="flex gap-2">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not" />
                  <Button type="button" size="sm" disabled={!reason.trim()} onClick={() => decide.mutate({ kind: "reject", id: s.id, reason: reason.trim() })}>
                    Reject
                  </Button>
                </span>
              ) : (
                <span className="flex gap-2">
                  <Button type="button" size="sm" variant="primary" disabled={decide.isPending} onClick={() => setAccepting(s.id)}>
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
