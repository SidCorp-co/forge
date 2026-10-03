"use client";

// The peek (`#/requirements?peek=REQ-12`): the same summary the full page's "Where it stands"
// draws — state, coverage, whom it waits on, the deciding facts, the primary act — beside the list.

import Link from "next/link";
import type { ReactNode } from "react";
import { Button, ErrorState, IconButton, Kbd, ProjectLoader } from "@/design";
import { workflowHref } from "@/features/workflows/routes";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useRequirement } from "../hooks";
import { rememberListOrigin } from "../routes";
import type { RequirementDetail } from "../types";
import { DesignStatusBadge } from "./badges";
import { PrimaryActions } from "./requirement-actions";
import { CoverageMarks, StateBadge, WaitBanner, WhoMark, revisionText, stamp } from "./standing-bits";

function Fact({ label, children, source }: { label: string; children: ReactNode; source?: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 border-b border-line-subtle py-2 text-13">
      <span className="pt-px text-12 text-subtle">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">{children}</span>
      {source ? <span className="col-start-2 min-w-0">{source}</span> : null}
    </div>
  );
}

/** Who a fact is read from, in the source-mark style: icon, name, a few words; the record on hover. */
export function Source({ kind, who, rel, tip }: { kind: string; who: string; rel?: string; tip?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-[5px] whitespace-nowrap text-11-5 text-subtle" title={tip}>
      <WhoMark kind={kind} who={who} />
      <span className="truncate">
        {who}
        {rel ? ` · ${rel}` : ""}
      </span>
    </span>
  );
}

/** The facts that decide where it stands; the peek lists them, the full page lays them in columns. */
export function decidingFacts(d: RequirementDetail, slug: string): { label: string; value: ReactNode; source?: ReactNode }[] {
  const f = d.standing.facts;
  const current = d.revisions.find((r) => r.state === "current");
  const design = d.workflows[0];
  const out: { label: string; value: ReactNode; source?: ReactNode }[] = [
    {
      label: "Revision",
      value: revisionText(d.currentRevision, d.standing),
      source: current?.decidedAt ? (
        <Source kind="person" who={current.decidedByName ?? "A signer"} rel="signed" tip={`Accepted ${stamp(current.decidedAt)}`} />
      ) : undefined,
    },
    {
      label: "Issues",
      value:
        f.issuesTotal === 0
          ? "None yet"
          : `Done ${f.issuesDone} of ${f.issuesTotal}${f.issuesRunning ? ` · Running ${f.issuesRunning}` : ""}`,
      source: <Source kind="system" who="Forge" rel="live" tip="Issues linked to this requirement" />,
    },
  ];
  if (design) {
    out.push({
      label: "Design",
      value: (
        <>
          <Link href={workflowHref(slug, design.flow)} className="text-link hover:underline">
            {design.title}
          </Link>
          {design.designStatus ? <DesignStatusBadge status={design.designStatus} /> : null}
          {d.workflows.length > 1 ? <span className="text-12 text-subtle">+{d.workflows.length - 1}</span> : null}
        </>
      ),
      source:
        design.approvedRevision !== null ? (
          <Source kind="system" who="Forge" rel={`rev ${design.approvedRevision} approved`} tip="The design's newest approved revision" />
        ) : undefined,
    });
  }
  out.push({
    label: "Owner",
    value: d.standing.owner?.name ?? "None",
    source: d.standing.owner ? <Source kind="person" who={d.standing.owner.name ?? "Unknown"} /> : undefined,
  });
  return out;
}

export function RequirementPeek({
  projectId,
  slug,
  reqKey,
  position,
  onMove,
  onClose,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  position: { at: number; of: number } | null;
  onMove: (by: number) => void;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const q = useRequirement(projectId, reqKey);
  return (
    <aside
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto border-line-subtle bg-app lg:sticky lg:inset-auto lg:top-0 lg:z-auto lg:h-[calc(100vh-48px)] lg:border-l"
      aria-label={`${reqKey} summary`}
      data-testid="requirement-peek"
    >
      <div className="sticky top-0 z-[3] flex items-center gap-1.5 border-b border-line-subtle bg-sunken px-3 py-2">
        <Button type="button" size="sm" className="lg:hidden" onClick={onClose}>
          ← Requirements
        </Button>
        <IconButton icon="arrowUp" size="sm" aria-label="Previous requirement (k)" disabled={!position || position.at <= 1} onClick={() => onMove(-1)} />
        <IconButton icon="arrowDown" size="sm" aria-label="Next requirement (j)" disabled={!position || position.at >= position.of} onClick={() => onMove(1)} />
        {position ? (
          <span className="mx-1 whitespace-nowrap font-mono text-11 text-subtle">
            {position.at} of {position.of}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button type="button" size="sm" onClick={onOpenFull} data-testid="open-full-page">
          Open full page ↗
        </Button>
        <IconButton icon="x" size="sm" aria-label="Close (Esc)" onClick={onClose} />
      </div>
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading requirement…" />
        </div>
      ) : q.isError || !q.data ? (
        <div className="grid min-h-[40vh] place-items-center p-4">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <PeekBody d={q.data} projectId={projectId} slug={slug} />
      )}
    </aside>
  );
}

function PeekBody({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const s = d.standing;
  return (
    <>
      <div className="px-[18px] pb-2.5 pt-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-11-5 font-semibold text-subtle">Requirement</span>
          <span className="font-mono text-11-5 font-semibold text-link" title={d.id}>
            {d.key}
          </span>
          <StateBadge state={s.state} />
        </div>
        <h2 className="mt-1.5 text-[17px] font-semibold leading-snug">{d.title}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-[18px] pb-2.5 text-12 text-muted">
        <span className="text-11-5 text-subtle">Coverage</span>
        <CoverageMarks coverage={s.coverage} />
        {s.coverage.length ? (
          <span>
            {s.facts.passing} of {s.facts.criteria} pass
          </span>
        ) : null}
      </div>
      <div className="px-[18px]">
        <WaitBanner standing={s} />
        <div className="mt-1.5">
          {decidingFacts(d, slug).map((f) => (
            <Fact key={f.label} label={f.label} source={f.source}>
              {f.value}
            </Fact>
          ))}
        </div>
      </div>
      <div className="px-[18px] pb-4 pt-3">
        <PrimaryActions projectId={projectId} slug={slug} d={d} inPeek onReview={rememberListOrigin} />
      </div>
      <div className="mt-auto border-t border-line-subtle px-[18px] pb-4 pt-2.5 text-11-5 text-subtle max-lg:hidden">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> full page · <Kbd>Esc</Kbd> close. Each fact names its source; hover it for the
        record it is read from.
      </div>
    </>
  );
}
