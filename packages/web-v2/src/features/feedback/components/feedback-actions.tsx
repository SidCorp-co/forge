"use client";

import { useState } from "react";
import { AcceptStep, Button, enumLabel, Input, LEGEND, Radio, RadioGroup, Textarea } from "@/design";
import { type IssuePick, IssuePicker } from "@/features/issue-picker/issue-picker";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { feedbackNote } from "@/lib/i18n/standing-copy";
import type { Copy } from "@/lib/i18n/product-copy";
import type { SuggestionView } from "@/features/suggestions/types";
import { useSuggestionDecision, useWaitingSuggestions } from "@/features/suggestions/hooks";
import { useFeedbackAction } from "../hooks";
import { type FeedbackPick, FeedbackPicker } from "./feedback-picker";
import { RetargetForm } from "./feedback-retarget";
import { TellShippedBar } from "./feedback-tell";
import { TriageVerbs } from "./feedback-verbs";
import type { FeedbackDedup, FeedbackTriage, FeedbackView } from "../types";

type Choice = "link_issue" | "file_issue" | "revision" | "new_requirement" | "answer" | "duplicate" | "decline";

const CHOICES = ["file_issue", "link_issue", "revision", "new_requirement", "answer", "duplicate", "decline"] as const satisfies readonly Choice[];

const OPTIONAL: readonly Choice[] = ["file_issue"];

/** The issues a person picked, by key: one stays one, several become a list. */
export function issueKeysOf(picked: readonly IssuePick[]): string | string[] {
  const keys = picked.map((p) => p.key);
  return keys.length === 1 ? (keys[0] as string) : keys;
}

function TriageForm({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [choice, setChoice] = useState<Choice>("file_issue");
  const [text, setText] = useState("");
  const [linked, setLinked] = useState<IssuePick[]>([]);
  const [original, setOriginal] = useState<FeedbackPick | null>(null);
  const ready =
    choice === "duplicate" ? original !== null : choice === "link_issue" ? linked.length > 0 : OPTIONAL.includes(choice) || text.trim() !== "";
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
                  : { route: "duplicate", duplicateOf: (original as FeedbackPick).key };
    act.mutate({ kind: "triage", triage });
  };
  const placeholder = (c: Exclude<Choice, "duplicate" | "link_issue">) => t(`feedback.placeholder.${c}`);
  return (
    <section className="grid gap-3" data-testid="feedback-triage">
      <h3 className="text-12 font-semibold text-muted">{f.can.accept ? t("feedback.triage.orRoute") : t("feedback.triage.yours")}</h3>
      <RadioGroup name={`triage-${f.key}`} value={choice} onChange={(v) => setChoice(v as Choice)} className="grid gap-2 sm:grid-cols-2">
        {CHOICES.map((c) => (
          <Radio
            key={c}
            value={c}
            label={
              <span className="grid">
                <span className="text-13 font-medium">{t(`feedback.choice.${c}`)}</span>
                <span className="text-12 text-muted">{t(`feedback.choice.${c}Hint`)}</span>
              </span>
            }
          />
        ))}
      </RadioGroup>
      {choice === "duplicate" ? (
        <FeedbackPicker projectId={projectId} self={f.key} value={original} onChange={setOriginal} />
      ) : choice === "link_issue" ? (
        <IssuePicker projectId={projectId} value={linked} onChange={setLinked} ariaLabel={t("feedback.triage.issuesAria")} />
      ) : choice === "answer" || choice === "decline" ? (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={placeholder(choice)} />
      ) : (
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder(choice)} />
      )}
      <RefusalLine error={act.error} />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={act.isPending}
          disabled={!ready}
          onClick={submit}
        >
          {choice === "decline" ? t("feedback.triage.decline") : t("feedback.triage.routeIt")}
        </Button>
      </div>
    </section>
  );
}

function VerifyBar({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const act = useFeedbackAction(projectId, f.key);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <section className="grid gap-2" data-testid="feedback-verify">
      <h3 className="text-12 font-semibold text-muted">{t("feedback.act.confirmFix")}</h3>
      <p className="text-12 text-muted" data-testid="verify-copy">
        {t("feedback.verify.copy")}
        {f.autoVerify ? t("feedback.verify.byDate", { at: time.dateTime(f.autoVerify.at), n: f.autoVerify.windowDays }) : t("feedback.verify.byWindow")}
      </p>
      {f.can.askVerify ? <p className="text-12 text-muted">{t("feedback.verify.asking")}</p> : null}
      {reopening ? (
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={t("feedback.verify.reopenPlaceholder")} />
      ) : null}
      <RefusalLine error={act.error} />
      <div className="flex gap-2">
        {reopening ? (
          <Button type="button" size="sm" variant="primary" disabled={!reason.trim()} loading={act.isPending} onClick={() => act.mutate({ kind: "reopen", reason: reason.trim() })}>
            {t("feedback.verify.reopen")}
          </Button>
        ) : (
          <>
            {f.can.verify ? (
              <Button type="button" size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ kind: "verify" })}>
                {t("feedback.verify.mark")}
              </Button>
            ) : null}
            {f.can.askVerify ? (
              <Button type="button" size="sm" loading={act.isPending} onClick={() => act.mutate({ kind: "verify-ask" })}>
                {t("feedback.verify.ask")}
              </Button>
            ) : null}
            {f.can.reopen ? (
              <Button type="button" size="sm" onClick={() => setReopening(true)}>
                {t("feedback.verify.reopen")}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function RedactBar({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [sure, setSure] = useState(false);
  return (
    <div className="grid gap-2">
      <RefusalLine error={act.error} />
      <div className="flex items-center gap-2">
        {sure ? (
          <>
            <span className="text-12 text-muted">{t("feedback.redact.consequence")}</span>
            <Button type="button" size="sm" variant="danger" loading={act.isPending} onClick={() => act.mutate({ kind: "redact" })}>
              {t("feedback.redact.confirm")}
            </Button>
          </>
        ) : (
          <button type="button" className="text-12 font-semibold text-muted hover:text-fg" onClick={() => setSure(true)}>
            {t("feedback.redact.open")}
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
      {f.can.tellShipped ? <TellShippedBar projectId={projectId} f={f} /> : null}
      {f.can.redact ? <RedactBar projectId={projectId} f={f} /> : null}
    </div>
  );
}

function routeLine(s: SuggestionView, t: Copy, language: string): string {
  const p = (s.payload ?? {}) as Partial<FeedbackTriage>;
  const carrier = (Array.isArray(p.issue) ? p.issue.join(", ") : p.issue) ?? p.duplicateOf ?? p.requirement ?? p.title ?? (p.createIssue ? t("feedback.proposal.aDraftIssue") : "");
  return [p.route ? enumLabel("feedbackRoute", p.route, language) : t("feedback.proposal.route"), carrier].filter(Boolean).join(" → ");
}

/** An assistant's triage suggestion is an accent bar an approver accepts (through the confirm step that takes
 *  their reason) or rejects with one, never an edit. */
export function Proposals({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
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
              {t("feedback.proposal.head", { who: s.producerKind === "person" ? t("feedback.proposal.aPerson") : t("feedback.proposal.anAgent") })}
            </span>
            <span className="text-13">{routeLine(s, t, language)}</span>
            {note ? <span className="text-12 text-muted">{note}</span> : null}
            {dedup ? (
              <span className="text-12 text-muted">
                {!dedup.ran
                  ? dedup.why
                    ? feedbackNote(dedup.why, language)
                    : t("feedback.proposal.noDedup")
                  : dedup.nearest
                    ? `${t("feedback.proposal.nearest", { key: dedup.nearest })}${dedup.similarity !== undefined ? ` (${dedup.similarity})` : ""}`
                    : t("feedback.proposal.noSimilar")}
              </span>
            ) : null}
            {f.can.triage ? (
              accepting === s.id ? (
                <AcceptStep
                  confirmLabel={t("feedback.proposal.accept")}
                  consequence={t("feedback.proposal.consequence", { route: routeLine(s, t, language) })}
                  loading={decide.isPending}
                  onCancel={() => setAccepting(null)}
                  onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, { onSuccess: () => setAccepting(null) })}
                />
              ) : rejecting === s.id ? (
                <span className="flex gap-2">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("feedback.proposal.whyNot")} />
                  <Button type="button" size="sm" disabled={!reason.trim()} onClick={() => decide.mutate({ kind: "reject", id: s.id, reason: reason.trim() })}>
                    {t("feedback.proposal.reject")}
                  </Button>
                </span>
              ) : (
                <span className="flex gap-2">
                  <Button type="button" size="sm" variant="primary" disabled={decide.isPending} onClick={() => setAccepting(s.id)}>
                    {t("feedback.proposal.accept")}
                  </Button>
                  <Button type="button" size="sm" onClick={() => setRejecting(s.id)}>
                    {t("feedback.proposal.reject")}
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
