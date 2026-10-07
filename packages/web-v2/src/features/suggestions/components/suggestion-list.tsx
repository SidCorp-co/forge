"use client";

import { useState } from "react";
import { AcceptStep, AGENT_TINT, Button, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { labelCopy } from "@/lib/i18n/labels";
import { type Copy, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { requirementAffected, useSuggestionDecision, useWaitingSuggestions } from "../hooks";
import type { SuggestionKind, SuggestionProducer, SuggestionView as Suggestion } from "../types";
import { BreakdownSlices } from "./breakdown-slices";

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? (v as Payload[]) : []);

const kindLabel = (t: Copy, kind: SuggestionKind) => t(`requirements.suggestion.kind.${kind}` as ProductCopyKey);
const producerLabel = (t: Copy, p: SuggestionProducer) => t(`requirements.suggestion.producer.${p}` as ProductCopyKey);
/** A feedback route as core names it, read as its label outside English (`issue` → its word). */
const routeWord = (route: string, language: string) => (language === "en" ? route : labelCopy(language)("feedbackRoute", route).toLowerCase());

/** One line saying what accepting it would do; the rest sits behind the expander and the tooltip. */
export function summaryOf(s: Suggestion, language: string): string {
  const t = productCopy(language);
  const p = (s.payload ?? {}) as Payload;
  switch (s.kind) {
    case "revision_diff":
      return str(p.changeSummary) ?? str(p.reason) ?? t("requirements.suggestion.newRevision");
    case "requirement_draft":
      return str(p.title) ?? t("requirements.suggestion.newRequirement");
    case "readiness": {
      const checks = list(p.checks);
      return t("requirements.suggestion.checksPass", { a: checks.filter((c) => c.passed === true).length, b: checks.length });
    }
    case "breakdown":
      return t("requirements.suggestion.issuesN", { n: list(p.issues).length });
    case "duplicate":
      return t("requirements.suggestion.duplicateOf", { key: str(p.duplicateOf) ?? "?" });
    case "triage":
      return str(p.note) ?? t("requirements.suggestion.triage");
    case "feedback_triage":
      return str(p.note) ?? t("requirements.suggestion.routeAs", { route: routeWord(str(p.route) ?? "?", language) });
    case "design_change":
      return str(p.reason) ?? t("requirements.suggestion.changeNode", { change: str(p.change) ?? t("requirements.suggestion.change") });
  }
}

/** What confirming an accept writes, said in the confirm step before it is pressed. */
export function acceptConsequence(s: Suggestion, language: string): string {
  const t = productCopy(language);
  const p = (s.payload ?? {}) as Payload;
  const r = s.baseRevision;
  switch (s.kind) {
    case "revision_diff":
      return t("requirements.suggestion.acceptRevision");
    case "requirement_draft":
      return t("requirements.suggestion.acceptDraft");
    case "readiness":
      return r !== null ? t("requirements.suggestion.acceptReadinessOf", { r }) : t("requirements.suggestion.acceptReadiness");
    case "breakdown":
      return t(r !== null ? "requirements.suggestion.acceptBreakdownOn" : "requirements.suggestion.acceptBreakdown", { n: list(p.issues).length, r: r ?? "" });
    case "duplicate":
      return t("requirements.suggestion.acceptDuplicate", { key: str(p.duplicateOf) ?? t("requirements.suggestion.theOneItNames") });
    case "triage":
      return t("requirements.suggestion.acceptTriage");
    case "feedback_triage":
      return t("requirements.suggestion.acceptRoute", { route: str(p.route) ? routeWord(str(p.route) as string, language) : t("requirements.suggestion.itNames") });
    case "design_change":
      return t("requirements.suggestion.acceptDesign");
  }
}

function detailLines(s: Suggestion, t: Copy): string[] {
  const p = (s.payload ?? {}) as Payload;
  if (s.kind === "revision_diff" || s.kind === "requirement_draft") {
    return list(p.criteria).map((c) => `${str(c.code) ?? t("requirements.suggestion.newCode")} · ${str(c.body) ?? ""}`);
  }
  if (s.kind === "readiness") {
    return list(p.checks).map(
      (c) => `${t(c.passed === true ? "requirements.suggestion.pass" : "requirements.suggestion.fail")} · ${str(c.check) ?? ""}${str(c.detail) ? ` — ${str(c.detail)}` : ""}`,
    );
  }
  return [];
}

function tipOf(s: Suggestion, t: Copy, dateTime: (at: string) => string): string {
  const who = producerLabel(t, s.producerKind);
  return [
    `kind: ${s.kind}`,
    s.baseRevision !== null ? t("requirements.suggestion.basedOn", { r: s.baseRevision }) : t("requirements.suggestion.noBase"),
    s.model ? t("requirements.suggestion.fromModel", { who, model: s.model }) : t("requirements.suggestion.from", { who }),
    t("requirements.suggestion.proposedAt", { at: dateTime(s.createdAt) }),
  ].join("\n");
}

/** "Pending": the suggestion's own state, in the assistant's colour. */
export function PendingBadge() {
  const t = useCopy();
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-pill px-2 py-px text-11-5 font-semibold"
      style={{ color: AGENT_TINT.fg }}
      title={t("requirements.suggestion.pendingTitle")}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: AGENT_TINT.dot }} />
      {t("requirements.suggestion.pending")}
    </span>
  );
}

function Row({ s, projectId, reqKey }: { s: Suggestion; projectId: string; reqKey: string }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  const time = useTimeFormat();
  const decide = useSuggestionDecision(projectId, requirementAffected(projectId, reqKey));
  const [step, setStep] = useState<"accept" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const details = detailLines(s, t);
  const busy = decide.isPending;
  return (
    <li
      className="grid gap-1.5 border-l-[3px] px-3 py-[9px] text-12-5"
      style={{ borderColor: AGENT_TINT.dot, background: AGENT_TINT.bg }}
      data-testid="requirement-suggestion"
      data-kind={s.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AGENT_TINT.fg }} title={tipOf(s, t, time.dateTime)}>
          {producerLabel(t, s.producerKind)} · {kindLabel(t, s.kind)}
        </span>
        <PendingBadge />
        <span className="text-12 text-subtle" title={time.dateTime(s.createdAt)}>
          {time.relative(s.createdAt)}
        </span>
      </div>
      <p className="text-13-5">{summaryOf(s, lang)}</p>
      {details.length > 0 || s.kind === "breakdown" ? (
        <details className="text-12 text-muted">
          <summary className="cursor-pointer select-none font-semibold" style={{ color: AGENT_TINT.fg }}>
            {t("requirements.suggestion.showDetails")}
          </summary>
          {s.kind === "breakdown" ? (
            <BreakdownSlices read={s.breakdown} />
          ) : (
            <ul className="mt-1 grid gap-0.5">
              {[...new Set(details)].map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button type="button" size="sm" disabled={busy} onClick={() => setStep((v) => (v === "accept" ? null : "accept"))} aria-expanded={step === "accept"}>
          {t("requirements.act.accept")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setStep((v) => (v === "reject" ? null : "reject"))} aria-expanded={step === "reject"}>
          {t("requirements.act.reject")}
        </Button>
      </div>
      {step === "accept" ? (
        <AcceptStep
          confirmLabel={t("requirements.act.accept")}
          consequence={acceptConsequence(s, lang)}
          loading={busy}
          onCancel={() => setStep(null)}
          onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, { onSuccess: () => setStep(null) })}
        />
      ) : null}
      {step === "reject" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate({ kind: "reject", id: s.id, reason: reason.trim() }, { onSuccess: () => setStep(null) });
          }}
        >
          <Input
            aria-label={t("requirements.suggestion.rejectWhy")}
            placeholder={t("requirements.suggestion.rejectWhy")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-[16rem] flex-1"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!reason.trim()} loading={busy}>
            {t("requirements.act.reject")}
          </Button>
        </form>
      ) : null}
      <RefusalLine error={decide.error} />
    </li>
  );
}

/** The suggestions waiting on this requirement, each an accent bar whose Accept opens a confirm step taking the
 *  reason and whose Reject requires one; nothing when none wait. */
export function RequirementSuggestions({ projectId, reqKey }: { projectId: string; reqKey: string }) {
  const q = useWaitingSuggestions(projectId, { requirement: reqKey });
  const rows = q.data?.suggestions ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="requirement-suggestions">
      <ul className="grid gap-2.5">
        {rows.map((s) => (
          <Row key={s.id} s={s} projectId={projectId} reqKey={reqKey} />
        ))}
      </ul>
    </section>
  );
}
