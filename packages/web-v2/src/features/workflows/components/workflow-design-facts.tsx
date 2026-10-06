"use client";

import { HEALTH_MARKER_KINDS, HEALTH_MARKER_LABELS, type WorkflowHealth } from "@forge/contracts/workflow-health";
import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import Link from "next/link";
import { Fact, FactsEmpty, FactsGroup, StatusBadge } from "@/design";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { markersByKind, sourceHref, targetWords } from "../health";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord } from "../types";
import { HealthMark } from "./health-parts";

/**
 * The rail's Health group (REQ-17 BC-17): a count per marker kind, then the markers grouped by kind,
 * each opening its source record. Counts show whether or not the canvas overlay is on.
 */
function HealthGroup({ health, slug }: { health: WorkflowHealth; slug: string }) {
  const total = health.markers.length;
  const groups = markersByKind(health.markers);
  return (
    <FactsGroup title="Health" count={total ? `Markers ${total}` : undefined} testId="facts-health">
      {!health.rooted.rooted ? (
        <p className="mb-2 text-12-5 text-muted" data-testid="health-unrooted">
          Unrooted: {health.rooted.missing.map((m) => (m === "approved_revision" ? "no approved revision" : "no requirement links it")).join(" and ")}, so the code is not observed against it.
        </p>
      ) : health.observation === null ? (
        <p className="mb-2 text-12-5 text-muted" data-testid="health-not-observed">
          The code has not been observed yet; every step reads planned.
        </p>
      ) : (
        <p className="mb-2 text-12-5 text-muted" title={formatStamp(health.observation.createdAt)} data-testid="health-observed">
          Code observed at <span className="font-mono">{health.observation.atSha.slice(0, 8)}</span> against r{health.observation.revision} · {formatRelativeTime(health.observation.createdAt)}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1" data-testid="health-counts">
        {HEALTH_MARKER_KINDS.map((k) => (
          <li key={k} className="flex min-w-0 items-center justify-between gap-2 text-12-5" data-kind={k} title={k}>
            <span className={health.counts[k] ? "text-fg" : "text-subtle"}>{HEALTH_MARKER_LABELS[k]}</span>
            <span className={`font-mono tabular-nums ${health.counts[k] ? "font-semibold" : "text-subtle"}`}>{health.counts[k]}</span>
          </li>
        ))}
      </ul>
      {health.needsYou > 0 ? (
        <p className="mt-2 text-12-5 font-semibold text-accent-text" data-testid="health-needs-you" title="Sources waiting on a person, and Rewrite-due or Not in design nodes with no decision">
          Needs a person: {health.needsYou}
        </p>
      ) : null}
      {groups.length ? (
        <div className="mt-2.5 border-t border-line-subtle" data-testid="health-markers">
          {groups.map((g) => (
            <details key={g.kind} className="border-b border-line-subtle py-1.5" data-kind={g.kind}>
              <summary className="flex cursor-pointer select-none items-center gap-2 text-12-5">
                <HealthMark kind={g.kind} />
              </summary>
              <ul className="mt-1 grid">
                {g.markers.map((m) => {
                  const href = sourceHref(slug, health.flow, m.source);
                  return (
                    <li key={`${m.rule}:${m.source.type}:${m.source.key}:${targetWords(m.target)}`} className="grid gap-0.5 border-t border-line-subtle py-1.5 text-12-5 first:border-t-0" data-testid="health-marker">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {href ? (
                          <Link href={href} className="flex-none font-mono text-12 font-semibold text-link hover:underline" title={`${m.source.type} · ${m.rule}`}>
                            {m.source.key}
                          </Link>
                        ) : (
                          <span className="flex-none font-mono text-12 text-subtle" title={`${m.source.type} · ${m.rule}`}>
                            {m.source.key}
                          </span>
                        )}
                        <span className="min-w-0 truncate text-subtle">{targetWords(m.target)}</span>
                      </span>
                      <span className="text-muted">{m.reason}</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      ) : null}
    </FactsGroup>
  );
}

/** design-reconciliation `reconciled-view`: the state, the dev version that carried it, and the BCs proven, read from core. */
function ReconciliationGroup({ health, slug }: { health: WorkflowHealth; slug: string }) {
  const r = health.reconciliation;
  return (
    <FactsGroup title="Reconciliation" testId="facts-reconciliation">
      <p className="mb-2 flex min-w-0 items-start gap-2 text-12-5 text-muted" data-testid="reconciliation-state" data-state={r.state}>
        <span className="flex-none">
          <StatusBadge family="reconciliation" value={r.state} />
        </span>
        <span className="min-w-0">{r.rule.charAt(0).toUpperCase() + r.rule.slice(1)}.</span>
      </p>
      <Fact label="Version" testId="reconciliation-version">
        {r.version ? (
          <span className="font-mono text-12-5" title={r.version.releasedAt ? `Released ${formatStamp(r.version.releasedAt)}` : undefined}>
            {r.version.version}
          </span>
        ) : (
          <span className="text-muted">No released version carries it yet</span>
        )}
      </Fact>
      <Fact label="BCs proven" testId="reconciliation-criteria">
        {r.criteria.total === 0 ? (
          <span className="text-muted">No business criterion traces this design</span>
        ) : (
          <span className="font-mono tabular-nums text-12-5" title="Business criteria tracing this design whose latest verdict passed">
            {r.criteria.proven} of {r.criteria.total}
          </span>
        )}
      </Fact>
      {r.issues.length ? (
        <Fact label="Carried by" testId="reconciliation-issues">
          {r.issues.map((k) => (
            <Link key={k} href={issueHref(slug, k)} className="font-mono text-12 font-semibold text-link hover:underline">
              {k}
            </Link>
          ))}
        </Fact>
      ) : null}
    </FactsGroup>
  );
}

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
  health: WorkflowHealth | undefined;
}

export function WorkflowDesignFacts({ d, record, shown, shownRevision, template, slug, health }: DesignFactsProps) {
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
      {health ? <HealthGroup health={health} slug={slug} /> : null}
      {health ? <ReconciliationGroup health={health} slug={slug} /> : null}
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
