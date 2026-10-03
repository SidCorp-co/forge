"use client";

import { useState } from "react";
import { Button, Input } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { RefusalLine } from "@/features/requirements/components/refusal";
import { useSuggestionDecision, useWaitingSuggestions } from "../hooks";
import type { SuggestionKind, SuggestionProducer, SuggestionView as Suggestion } from "../types";

const KIND_LABEL: Record<SuggestionKind, string> = {
  requirement_draft: "Requirement draft",
  revision_diff: "Revision",
  readiness: "Readiness",
  breakdown: "Breakdown",
  triage: "Triage",
  duplicate: "Duplicate",
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
function summaryOf(s: Suggestion): string {
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

function Row({ s, projectId, reqKey }: { s: Suggestion; projectId: string; reqKey: string }) {
  const decide = useSuggestionDecision(projectId, reqKey);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const details = detailLines(s);
  const busy = decide.isPending;
  return (
    <li
      className="grid gap-1.5 border-l-2 py-1.5 pl-3"
      style={{ borderColor: "var(--accent)" }}
      data-testid="requirement-suggestion"
      data-kind={s.kind}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-13">
        <span className="text-12 font-semibold" style={{ color: "var(--accent-text)" }} title={tipOf(s)}>
          {KIND_LABEL[s.kind]}
        </span>
        <span className="min-w-0 flex-1">{summaryOf(s)}</span>
        <span className="text-12 text-subtle">{formatRelativeTime(s.createdAt)}</span>
        <span className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="primary" loading={busy} onClick={() => decide.mutate({ kind: "accept", id: s.id })}>
            Accept
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => setRejecting((v) => !v)} aria-expanded={rejecting}>
            Reject
          </Button>
        </span>
      </div>
      {details.length > 0 ? (
        <details className="text-12 text-muted">
          <summary className="cursor-pointer select-none">
            {details.length} {details.length === 1 ? "line" : "lines"}
          </summary>
          <ul className="mt-1 grid gap-0.5">
            {[...new Set(details)].map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      ) : null}
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
  const q = useWaitingSuggestions(projectId, reqKey);
  const rows = q.data?.suggestions ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="requirement-suggestions">
      <h3 className="text-12 font-semibold text-muted">
        Suggestions
        <span className="ml-1.5 font-normal text-subtle">{rows.length}</span>
      </h3>
      <ul className="grid gap-2">
        {rows.map((s) => (
          <Row key={s.id} s={s} projectId={projectId} reqKey={reqKey} />
        ))}
      </ul>
    </section>
  );
}
