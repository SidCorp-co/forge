"use client";

// The at-a-glance facts of one requirement: status and whose turn, lifecycle, owner, revision,
// coverage, issues, open feedback, designs, needs and dates. The full page's sticky rail and the peek
// draw this one component through the shared FactsGroup/Fact rows, so the main column never repeats a
// fact and both surfaces read the same.

import Link from "next/link";
import { ActorChip, Fact, FactsEmpty, FactsGroup, LEGEND, StatusBadge, Tooltip, WaitingOn } from "@/design";
import { useFeedbackList } from "@/features/feedback/hooks";
import { feedbackHref } from "@/features/feedback/routes";
import { issueHref } from "@/features/issues/routes";
import { workflowHref } from "@/features/workflows/routes";
import { formatRelativeTime, formatStamp as stamp } from "@/lib/utils/format";
import type { RequirementDetail } from "../types";
import { CoverageSummary, Stepper, waitingView } from "./standing-bits";

/** Feedback about this requirement that is not yet verified or declined (ISS-59's target arc). */
function OpenFeedback({ projectId, slug, reqKey }: { projectId: string; slug: string; reqKey: string }) {
  const q = useFeedbackList(projectId);
  const open = (q.data?.feedback ?? []).filter((f) => f.target.type === "requirement" && f.target.key === reqKey && f.attention !== "done");
  if (q.isLoading) return null;
  return (
    <FactsGroup title="Open feedback" count={open.length ? `Open ${open.length}` : undefined} testId="facts-feedback">
      {q.isError ? (
        <FactsEmpty>Feedback could not be read.</FactsEmpty>
      ) : open.length === 0 ? (
        <FactsEmpty>No open feedback about it.</FactsEmpty>
      ) : (
        <ul className="grid gap-1">
          {open.map((f) => (
            <li key={f.id} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-feedback">
              <Link href={feedbackHref(slug, f.key)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {f.key}
              </Link>
              <span className="min-w-0 flex-1 truncate" title={f.title}>
                {f.title}
              </span>
              <StatusBadge family="feedbackPhase" value={f.phase} />
            </li>
          ))}
        </ul>
      )}
    </FactsGroup>
  );
}

export function RequirementFacts({
  d,
  projectId,
  slug,
  onOpenRevisions,
}: {
  d: RequirementDetail;
  projectId: string;
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
      <FactsGroup title="Status">
        <Fact label="State">
          <StatusBadge family="requirement" value={s.state} />
        </Fact>
        {s.attentionGroup !== "done" ? (
          <Fact label="Waiting on">
            <WaitingOn w={waitingView(s.waitingOn)} />
          </Fact>
        ) : null}
        <Fact label="Owner">
          {s.owner ? <ActorChip name={s.owner.name ?? "Unknown"} kind={s.owner.kind} /> : <span className="text-subtle">No owner</span>}
        </Fact>
        <Fact label="Current">
          <span>{d.currentRevision !== null ? `r${d.currentRevision}` : "None accepted yet"}</span>
        </Fact>
        {open !== null ? (
          <Fact label={f.proposedRevision !== null ? "Proposed" : "In draft"}>
            {onOpenRevisions ? (
              <button type="button" onClick={onOpenRevisions} className="text-link hover:underline" data-testid="facts-open-revision">
                r{open}
              </button>
            ) : (
              <span>r{open}</span>
            )}
          </Fact>
        ) : null}
        <div className="pt-2.5">
          <Stepper state={s.state} />
        </div>
      </FactsGroup>

      <FactsGroup title="Coverage" count={s.coverage.length ? `Passing ${f.passing} of ${f.criteria}` : undefined} testId="facts-coverage">
        <CoverageSummary coverage={s.coverage} />
      </FactsGroup>

      <FactsGroup title="Issues" count={f.issuesTotal ? `Done ${f.issuesDone} of ${f.issuesTotal}` : undefined} testId="facts-issues">
        {d.issues.length === 0 ? (
          <FactsEmpty>Not broken down into issues yet.</FactsEmpty>
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
                  <span role="img" aria-label="Changed since plan" title="Changed since plan" className="size-1.5 flex-none rounded-full" style={{ background: LEGEND.you.dot }} />
                ) : null}
                <StatusBadge family="issue" value={i.status} tone={i.tone} />
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

      <OpenFeedback projectId={projectId} slug={slug} reqKey={d.key} />

      <FactsGroup title="Design" testId="facts-design">
        {d.workflows.length === 0 ? (
          <FactsEmpty>No design linked.</FactsEmpty>
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
                      <StatusBadge family="design" value={w.designStatus} />
                    </span>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

      {needs.length > 0 ? (
        <FactsGroup title="Needs from other projects">
          <ul className="grid gap-1">
            {needs.map((p) => (
              <li key={`${p.contractSlug}@${p.contractVersion}`} className="font-mono text-12" title="Pinned when it was agreed">
                {p.contractSlug} ≥ {p.contractVersion}
              </li>
            ))}
          </ul>
        </FactsGroup>
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
