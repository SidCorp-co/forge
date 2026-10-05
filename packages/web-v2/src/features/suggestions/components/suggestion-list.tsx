"use client";

import { useState } from "react";
import { AGENT_TINT, Button, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { formatRelativeTime } from "@/lib/utils/format";
import { requirementAffected, useSuggestionDecision, useWaitingSuggestions } from "../hooks";
import type { SuggestionKind, SuggestionProducer, SuggestionView as Suggestion } from "../types";

export const KIND_LABEL: Record<SuggestionKind, string> = {
  requirement_draft: "Requirement draft",
  revision_diff: "Revision",
  readiness: "Readiness",
  breakdown: "Breakdown",
  triage: "Triage",
  duplicate: "Duplicate",
  feedback_triage: "Feedback triage",
  design_change: "Design change",
};

const PRODUCER_LABEL: Record<SuggestionProducer, string> = {
  ba_assistant: "BA assistant",
  agent: "Agent",
  person: "Person",
};

type Payload = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const list = (v: unknown) => (Array.isArray(v) ? (v as Payload[]) : []);

/** One line saying what accepting it would do; the rest sits behind the expander and the tooltip. */
export function summaryOf(s: Suggestion): string {
  const p = (s.payload ?? {}) as Payload;
  switch (s.kind) {
    case "revision_diff":
      return str(p.changeSummary) ?? str(p.reason) ?? "A new revision";
    case "requirement_draft":
      return str(p.title) ?? "A new requirement";
    case "readiness": {
      const checks = list(p.checks);
      return `${checks.filter((c) => c.passed === true).length} of ${checks.length} checks pass`;
    }
    case "breakdown":
      return `${list(p.issues).length} issues`;
    case "duplicate":
      return `Duplicate of ${str(p.duplicateOf) ?? "?"}`;
    case "triage":
      return str(p.note) ?? "Triage";
    case "feedback_triage":
      return str(p.note) ?? `Route as ${str(p.route) ?? "?"}`;
    case "design_change":
      return str(p.reason) ?? `${str(p.change) ?? "Change"} a node`;
  }
}

function detailLines(s: Suggestion): string[] {
  const p = (s.payload ?? {}) as Payload;
  if (s.kind === "revision_diff" || s.kind === "requirement_draft") {
    return list(p.criteria).map((c) => `${str(c.code) ?? "New"} · ${str(c.body) ?? ""}`);
  }
  if (s.kind === "readiness") {
    return list(p.checks).map((c) => `${c.passed === true ? "Pass" : "Fail"} · ${str(c.check) ?? ""}${str(c.detail) ? ` — ${str(c.detail)}` : ""}`);
  }
  if (s.kind === "breakdown") return list(p.issues).map((i) => str(i.title) ?? "");
  return [];
}

function tipOf(s: Suggestion): string {
  return [
    `kind: ${s.kind}`,
    s.baseRevision !== null ? `Based on r${s.baseRevision}` : "No base revision",
    `From ${PRODUCER_LABEL[s.producerKind]}${s.model ? ` (${s.model})` : ""}`,
    `Proposed ${new Date(s.createdAt).toLocaleString()}`,
  ].join("\n");
}

/** "Pending": the suggestion's own state, in the assistant's colour. */
export function PendingBadge() {
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-pill px-2 py-px text-11-5 font-semibold"
      style={{ color: AGENT_TINT.fg }}
      title="proposed · Waiting for a person to accept or reject it; never applied on its own"
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: AGENT_TINT.dot }} />
      Pending
    </span>
  );
}

function Row({ s, projectId, reqKey }: { s: Suggestion; projectId: string; reqKey: string }) {
  const decide = useSuggestionDecision(projectId, requirementAffected(projectId, reqKey));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const details = detailLines(s);
  const busy = decide.isPending;
  return (
    <li
      className="grid gap-1.5 border-l-[3px] px-3 py-[9px] text-12-5"
      style={{ borderColor: AGENT_TINT.dot, background: AGENT_TINT.bg }}
      data-testid="requirement-suggestion"
      data-kind={s.kind}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold" style={{ color: AGENT_TINT.fg }} title={tipOf(s)}>
          {PRODUCER_LABEL[s.producerKind]} · {KIND_LABEL[s.kind]}
        </span>
        <PendingBadge />
        <span className="text-12 text-subtle" title={new Date(s.createdAt).toLocaleString()}>
          {formatRelativeTime(s.createdAt)}
        </span>
      </div>
      <p className="text-13-5">{summaryOf(s)}</p>
      {details.length > 0 ? (
        <details className="text-12 text-muted">
          <summary className="cursor-pointer select-none font-semibold" style={{ color: AGENT_TINT.fg }}>
            Show details
          </summary>
          <ul className="mt-1 grid gap-0.5">
            {[...new Set(details)].map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button type="button" size="sm" loading={busy} onClick={() => decide.mutate({ kind: "accept", id: s.id })}>
          Accept
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting}>
          Reject
        </Button>
      </div>
      {rejecting ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate({ kind: "reject", id: s.id, reason: reason.trim() }, { onSuccess: () => setRejecting(false) });
          }}
        >
          <Input
            aria-label="Why it is rejected"
            placeholder="Why it is rejected"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-w-[16rem] flex-1"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!reason.trim()} loading={busy}>
            Reject
          </Button>
        </form>
      ) : null}
      <RefusalLine error={decide.error} />
    </li>
  );
}

/** The suggestions waiting on this requirement, each an accent bar with Accept and Reject; nothing when none wait. */
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
