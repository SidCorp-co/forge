"use client";

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { Fact, FactsEmpty, FactsGroup, StatusBadge } from "@/design";
import { issueHref } from "@/features/issues/routes";
import { requirementHref } from "@/features/requirements/routes";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord } from "../types";

function Requirements({ d, slug }: { d: WorkflowDesign; slug: string }) {
  return (
    <FactsGroup title="Requirement" count={d.requirements.length > 1 ? `Linked ${d.requirements.length}` : undefined} testId="facts-requirement">
      {d.requirements.length === 0 ? (
        <FactsEmpty>No requirement links this design.</FactsEmpty>
      ) : (
        <ul className="grid gap-1.5">
          {d.requirements.map((r) => (
            <li key={r.key} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-requirement">
              <Link href={requirementHref(slug, r.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {r.key}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={r.title}>
                {r.title}
              </span>
              {r.pinnedRevision !== null ? (
                <span className="flex-none font-mono text-11-5 text-subtle" title={`${r.key}'s agreed baseline pins revision ${r.pinnedRevision} of this design`}>
                  r{r.pinnedRevision}
                </span>
              ) : null}
              <StatusBadge family="requirement" value={r.status} />
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

function BuildGate({ d, slug }: { d: WorkflowDesign; slug: string }) {
  return (
    <FactsGroup title="Build gate" count={d.builds.length ? `Issues ${d.builds.length}` : undefined} testId="facts-build-gate">
      <p className="mb-2 flex min-w-0 items-start gap-2 text-12-5 text-muted" data-testid="build-gate" data-open={d.gate.open}>
        <span className="flex-none">
          <StatusBadge family="buildGate" value={d.gate.open ? "open" : "held"} />
        </span>
        <span className="min-w-0">{d.gate.rule.charAt(0).toUpperCase() + d.gate.rule.slice(1)}.</span>
      </p>
      {d.builds.length === 0 ? (
        <FactsEmpty>No issue builds this design yet.</FactsEmpty>
      ) : (
        <ul className="grid gap-1.5">
          {d.builds.map((b) => (
            <li key={b.issueId} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-build">
              <Link href={issueHref(slug, b.displayId)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {b.displayId}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={b.title}>
                {b.title}
              </span>
              <StatusBadge family="issue" value={b.status} />
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

interface DesignFactsProps {
  d: WorkflowDesign;
  record: WorkflowRecord;
  shown: WorkflowBody;
  shownRevision: number;
  template: WorkflowTemplate | null;
  slug: string;
}

export function WorkflowDesignFacts({ d, record, shown, shownRevision, template, slug }: DesignFactsProps) {
  const latest = d.revisions[0] ?? null;
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision) ?? null;
  const shownState = d.revisions.find((r) => r.revision === shownRevision)?.state ?? null;
  const owned = shown.steps.filter((s) => s.node?.owner).length;
  const deadlines = shown.steps.filter((s) => s.node?.sla).length;
  const unit = shown.kind === "state" ? "states" : "steps";
  return (
    <div data-testid="design-facts">
      {shown.summary ? (
        <FactsGroup title="About" testId="facts-about">
          <p className="line-clamp-5 text-13 leading-relaxed-1-6 text-fg" title={shown.summary} data-testid="design-summary">
            {shown.summary}
          </p>
        </FactsGroup>
      ) : null}
      <Requirements d={d} slug={slug} />
      <BuildGate d={d} slug={slug} />
      <FactsGroup title="Properties" testId="facts-properties">
        <Fact label="Revision" testId="fact-revision">
          <span className="font-mono text-12-5">r{shownRevision}</span>
          {shownState ? <StatusBadge family="designRevision" value={shownState} /> : null}
        </Fact>
        <Fact label="Approved" testId="fact-approved">
          {approved ? (
            <span title={approved.decidedAt ? `Approved ${formatStamp(approved.decidedAt)}` : undefined}>
              Rev {approved.revision}
              {approved.decidedByName ? ` by ${approved.decidedByName}` : ""}
            </span>
          ) : d.approvedRevision !== null ? (
            <span>Rev {d.approvedRevision}</span>
          ) : (
            <span className="text-muted">Not approved yet</span>
          )}
        </Fact>
        <Fact label="Approver">
          <span title={`Whoever holds ${d.approver} on the project: a project admin, or an org owner or admin, person or agent`}>
            Holders of <span className="font-mono">{d.approver}</span>
          </span>
        </Fact>
        <Fact label="Template">
          <span title={template ? `${template.id}@${template.version}` : "No template: drawn before templates"}>{template?.title ?? "None"}</span>
        </Fact>
        <Fact label={unit === "states" ? "States" : "Steps"}>
          <span>
            {shown.steps.length}
            <span className="text-muted">
              {" "}
              · {owned} with an owner · {deadlines} {deadlines === 1 ? "deadline" : "deadlines"}
            </span>
          </span>
        </Fact>
        <Fact label="Drawn by">
          <span title={latest ? `Proposed ${formatStamp(latest.proposedAt)}` : undefined}>{latest ? (latest.proposedByName ?? latest.proposedBy) : record.writerName}</span>
        </Fact>
        <Fact label="Updated">
          <span title={formatStamp(record.document.updatedAt)}>{formatRelativeTime(record.document.updatedAt)}</span>
        </Fact>
      </FactsGroup>
    </div>
  );
}
