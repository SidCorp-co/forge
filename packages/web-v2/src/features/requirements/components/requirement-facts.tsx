"use client";

// The at-a-glance facts of one requirement: status and whose turn, lifecycle, owner, revision,
// coverage, issues, feedback, designs, needs and dates. The full page's sticky rail and the peek
// draw this one component through the shared FactsGroup/Fact rows, so the main column never repeats a
// fact and both surfaces read the same.

import Link from "next/link";
import { ActorChip, enumLabel, Fact, FactsEmpty, FactsGroup, LEGEND, StatusBadge, Tooltip, WaitingOn } from "@/design";
import { FeedbackRailItem } from "@/features/feedback/components/feedback-rail-item";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { workflowHref } from "@/lib/routes/workflows";
import { formatRelativeTime, formatStamp as stamp } from "@/lib/utils/format";
import { requirementHref } from "@/lib/routes/requirements";
import type { FeedbackRoute } from "@forge/contracts/feedback";
import type { ScopeForecast } from "@forge/contracts/forecast";
import { criteriaRestText } from "@/features/forecast/text";
import { useRequirementForecast } from "@/features/forecast/hooks";
import type { RequirementDetail, RequirementFeedbackItem } from "../types";
import { CoverageSummary, Stepper } from "./standing-bits";

/** "3 of 5 criteria proven · rest forecast live 14:10 – 18:50 today": the proof so far, then when the rest is in people's hands. */
function CriteriaRest({ passing, criteria, scope }: { passing: number; criteria: number; scope: ScopeForecast }) {
  const read = criteriaRestText(passing, criteria, scope);
  if (!read) return null;
  return (
    <p className="pb-1.5" data-testid="facts-forecast">
      <span className="fg-body-sm text-muted" title={read.detail} data-testid="criteria-rest-line">
        {read.line}
      </span>
    </p>
  );
}

const VIA_LABEL: Record<RequirementFeedbackItem["via"]["type"], string> = {
  requirement: "",
  issue: "On",
  workflow: "On design",
  release: "On release",
  route: "Carried by",
};

/** Where a carrier's key links: an issue, a requirement or a root item; a revision suggestion has no page. */
function carrierHrefOf(route: FeedbackRoute, slug: string, key: string): string | null {
  if (route === "issue") return issueHref(slug, key);
  if (route === "new_requirement") return requirementHref(slug, key);
  return route === "duplicate" ? feedbackHref(slug, key) : null;
}

function FeedbackRow({ f, slug }: { f: RequirementFeedbackItem; slug: string }) {
  const r = f.route;
  const carriers = r ? r.carriers.flatMap((c) => (c.key && carrierHrefOf(r.route, slug, c.key) ? [{ key: c.key, href: carrierHrefOf(r.route, slug, c.key) as string }] : [])) : [];
  const via = f.via.type === "requirement" || f.via.type === "route" ? null : `${VIA_LABEL[f.via.type]} ${f.via.key}`;
  return (
    <FeedbackRailItem slug={slug} itemKey={f.key} title={f.title} phase={f.phase}>
      {via || r ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-muted" data-testid="rail-feedback-route">
          {via ? <span>{via}</span> : null}
          {via && r ? <span aria-hidden>·</span> : null}
          {r ? <span>{enumLabel("feedbackRoute", r.route)}</span> : null}
          {carriers.map((c) => (
            <Link key={c.key} href={c.href} className="font-mono text-link hover:underline">
              {c.key}
            </Link>
          ))}
        </span>
      ) : null}
    </FeedbackRailItem>
  );
}

function FeedbackFacts({ items, slug }: { items: RequirementFeedbackItem[]; slug: string }) {
  const open = items.filter((f) => f.open);
  const closed = items.filter((f) => !f.open);
  return (
    <FactsGroup title="Feedback" count={items.length ? `Open ${open.length} of ${items.length}` : undefined} testId="facts-feedback">
      {items.length === 0 ? (
        <FactsEmpty>No feedback about it.</FactsEmpty>
      ) : (
        <>
          {open.length ? (
            <ul className="grid gap-1.5">
              {open.map((f) => (
                <FeedbackRow key={f.id} f={f} slug={slug} />
              ))}
            </ul>
          ) : (
            <FactsEmpty>No open feedback.</FactsEmpty>
          )}
          {closed.length ? (
            <details className="mt-2" data-testid="rail-feedback-closed">
              <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">Closed {closed.length}</summary>
              <ul className="mt-1.5 grid gap-1.5">
                {closed.map((f) => (
                  <FeedbackRow key={f.id} f={f} slug={slug} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </FactsGroup>
  );
}

export function RequirementFacts({
  d,
  slug,
  onOpenRevisions,
  projectId,
}: {
  d: RequirementDetail;
  slug: string;
  /** Reads when its issues are forecast to have landed. */
  projectId: string;
  /** Opens the revisions view; the peek, which has none, leaves it out and the revision reads as text. */
  onOpenRevisions?: () => void;
}) {
  const forecast = useRequirementForecast(projectId, d.key).data;
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
            <WaitingOn w={s.waitingOn} />
          </Fact>
        ) : null}
        <Fact label="Owner">
          {s.owner ? <ActorChip name={s.owner.name ?? "Unknown"} kind={s.owner.kind} /> : <span className="text-subtle">No owner</span>}
        </Fact>
        <Fact label="Current">
          <span>{d.currentRevision !== null ? `r${d.currentRevision}` : "None accepted yet"}</span>
        </Fact>
        {d.request ? (
          <Fact label="Requested by">
            <span title={`A contract request for ${d.request.contract}; only this project agrees it`}>{d.request.project}</span>
          </Fact>
        ) : null}
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
        {d.issues.length > 0 && forecast?.forecast ? <CriteriaRest passing={f.passing} criteria={f.criteria} scope={forecast} /> : null}
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

      <FeedbackFacts items={d.feedback} slug={slug} />

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

      {d.bindings.length > 0 ? (
        <FactsGroup title="Screen bindings" count={`${d.bindings.length}`} testId="facts-bindings">
          <ul className="grid gap-1">
            {d.bindings.map((b) => (
              <li
                key={`${b.workflowId}|${b.step}|${b.contract}|${b.element}`}
                className="grid min-w-0 gap-0.5 text-13"
                data-testid="rail-binding"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate" title={`${b.flow} r${b.designRevision}, step ${b.step}: ${b.contract}${b.pinnedVersion ? `@${b.pinnedVersion}` : ""}`}>
                    {b.step} <span className="font-mono text-12 text-subtle">{b.element}</span>
                  </span>
                  {b.brokenBy ? (
                    <span className="flex-none text-12 text-danger" title={`${b.contract} ${b.brokenBy} removed or broke this element; re-agree to re-baseline`}>
                      Broken by {b.brokenBy}
                    </span>
                  ) : null}
                </span>
                {b.buildingIssues.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1 text-12 text-subtle" data-testid="rail-binding-builds">
                    Built by
                    {b.buildingIssues.map((i) => (
                      <Link key={i.issueId} href={issueHref(slug, i.displayId)} title={`${i.title} (${i.status})`} className="font-mono text-link hover:underline">
                        {i.displayId}
                      </Link>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </FactsGroup>
      ) : null}

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
