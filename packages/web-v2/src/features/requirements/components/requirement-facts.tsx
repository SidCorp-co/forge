"use client";

// The at-a-glance facts of one requirement: status and whose turn, lifecycle, owner, revision,
// coverage, issues, designs, needs and dates. The full page's sticky rail and the peek draw this one
// component, so the main column never repeats a fact and both surfaces read the same.

import Link from "next/link";
import type { ReactNode } from "react";
import { StatusChip, Tooltip } from "@/design";
import { issueStatusChip } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { workflowHref } from "@/features/workflows/routes";
import { formatRelativeTime } from "@/lib/utils/format";
import type { RequirementDetail } from "../types";
import { DesignStatusBadge } from "./badges";
import { CoverageSummary, PersonChip, StateBadge, Stepper, WaitingOn, stamp, toneOf } from "./standing-bits";

export const issueHref = (slug: string, key: string) => `/projects/${encodeURIComponent(slug)}/issues/${encodeURIComponent(key)}`;

export function IssueChip({ status }: { status: string }) {
  const c = issueStatusChip(status as IssueStatus);
  return <StatusChip status={c.status} label={c.label} glyph={c.glyph} title={c.title} size="sm" />;
}

/** A rail group's heading: primary colour, one step above its labels; a label-first counter on the right. */
function Group({ title, count, children, testId }: { title: string; count?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0" data-testid={testId}>
      <h3 className="mb-2 flex items-baseline gap-2 text-13 font-semibold text-fg">
        {title}
        {count ? <span className="ml-auto text-12 font-medium text-muted">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2 py-[5px] text-13">
      <span className="text-12-5 font-medium text-muted">{k}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</span>
    </div>
  );
}

export function RequirementFacts({
  d,
  slug,
  onOpenRevisions,
}: {
  d: RequirementDetail;
  slug: string;
  /** Opens the revisions view; the peek, which has none, leaves it out and the revision reads as text. */
  onOpenRevisions?: () => void;
}) {
  const s = d.standing;
  const f = s.facts;
  const baseline = d.baselines[0];
  const needs = baseline?.pins.filter((p) => p.kind === "contract-version") ?? [];
  const open = f.proposedRevision ?? f.draftRevision;
  return (
    <div data-testid="requirement-facts">
      <Group title="Status">
        <Row k="State">
          <StateBadge state={s.state} />
        </Row>
        {s.attentionGroup !== "done" ? (
          <Row k="Waiting on">
            <WaitingOn w={s.waitingOn} />
          </Row>
        ) : null}
        <Row k="Owner">
          {s.owner ? (
            <PersonChip name={s.owner.name ?? "Unknown"} kind={s.owner.kind} />
          ) : (
            <span className="text-subtle">No owner</span>
          )}
        </Row>
        <Row k="Current">
          <span>{d.currentRevision !== null ? `r${d.currentRevision}` : "None accepted yet"}</span>
        </Row>
        {open !== null ? (
          <Row k={f.proposedRevision !== null ? "Proposed" : "In draft"}>
            {onOpenRevisions ? (
              <button type="button" onClick={onOpenRevisions} className="text-link hover:underline" data-testid="facts-open-revision">
                r{open}
              </button>
            ) : (
              <span>r{open}</span>
            )}
          </Row>
        ) : null}
        <div className="pt-2.5">
          <Stepper state={s.state} />
        </div>
      </Group>

      <Group title="Coverage" count={s.coverage.length ? `Passing ${f.passing} of ${f.criteria}` : undefined} testId="facts-coverage">
        <CoverageSummary coverage={s.coverage} />
      </Group>

      <Group title="Issues" count={f.issuesTotal ? `Done ${f.issuesDone} of ${f.issuesTotal}` : undefined} testId="facts-issues">
        {d.issues.length === 0 ? (
          <p className="text-12-5 text-subtle">Not broken down into issues yet.</p>
        ) : (
          <ul className="grid gap-1">
            {d.issues.map((i) => (
              <li key={i.issueId} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-issue">
                <Link href={issueHref(slug, i.displayId)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                  {i.displayId}
                </Link>
                <span className="min-w-0 flex-1 truncate" title={i.changedSincePlan ? `${i.title} · planned on r${i.plannedRevision}; the requirement moved since` : i.title}>
                  {i.title}
                </span>
                {i.changedSincePlan ? (
                  <span role="img" aria-label="Changed since plan" title="Changed since plan" className="size-1.5 flex-none rounded-full" style={{ background: toneOf("you").dot }} />
                ) : null}
                <IssueChip status={i.status} />
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Design" testId="facts-design">
        {d.workflows.length === 0 ? (
          <p className="text-12-5 text-subtle">No design linked.</p>
        ) : (
          <ul className="grid gap-1">
            {d.workflows.map((w) => (
              <li key={w.workflowId} className="flex min-w-0 items-center gap-1.5 text-13">
                <Link href={workflowHref(slug, w.flow)} className="min-w-0 flex-1 truncate text-link hover:underline">
                  {w.title}
                </Link>
                {w.designStatus ? (
                  <Tooltip label={w.approvedRevision !== null ? `Newest approved revision: ${w.approvedRevision}` : "No approved revision yet"}>
                    <span className="inline-flex">
                      <DesignStatusBadge status={w.designStatus} />
                    </span>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Group>

      {needs.length > 0 ? (
        <Group title="Needs from other projects">
          <ul className="grid gap-1">
            {needs.map((p) => (
              <li key={`${p.contractSlug}@${p.contractVersion}`} className="font-mono text-12" title="Pinned when it was agreed">
                {p.contractSlug} ≥ {p.contractVersion}
              </li>
            ))}
          </ul>
        </Group>
      ) : null}

      <div className="border-t border-line-subtle pt-3 text-12 text-subtle" data-testid="facts-dates">
        <span title={stamp(d.createdAt)}>Created {formatRelativeTime(d.createdAt)}</span>
        {baseline ? (
          <>
            {" · "}
            <span title={`Agreed ${stamp(baseline.agreedAt)}${baseline.agreedByName ? ` by ${baseline.agreedByName}` : ""}`}>
              Agreed r{baseline.revision} {formatRelativeTime(baseline.agreedAt)}
            </span>
          </>
        ) : null}
        {" · "}
        <span title={stamp(s.touchedAt)}>Updated {formatRelativeTime(s.touchedAt)}</span>
      </div>
    </div>
  );
}
