"use client";

import { LANDING_SURFACE_LABELS, LANDING_SURFACES, type LandingSurface } from "@forge/contracts/landing-artifacts";
import { RELEASE_PROOF_LABELS } from "@forge/contracts/releases";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  EnumBadge,
  FieldLabel,
  FilterChip,
  GroupedList,
  type ListGroup,
  type ListRowView,
  StatusBadge,
  Tooltip,
  useGroupFold,
  ViewHeading,
  WaitingOn,
} from "@/design";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseDetail, ReleaseIssueView, ReleaseNoteEntry, ReleaseSummary } from "../types";
import { DisclosureToggle, GateLine } from "./release-bits";
import { TourHint } from "@/features/tours/components/tour-hint";
import { changesSentence, WhatChanges } from "./release-changes";
import { WhatUsersGet } from "./release-users-get";
import { ReleaseTrain } from "./release-train";

export const RELEASE_TABS = ["overview", "issues", "criteria", "checks", "notes"] as const;
export type ReleaseTab = (typeof RELEASE_TABS)[number];

const MAINTENANCE = "Maintenance";

function Requirements({ r, slug }: { r: ReleaseDetail; slug: string }) {
  if (r.requirementsCompleted.length === 0) {
    return <p className="text-13 text-subtle">None of its issues belong to a requirement.</p>;
  }
  return (
    <ul className="border-t border-line-subtle" data-testid="release-requirements">
      {r.requirementsCompleted.map((q) => (
        <li key={q.key} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13">
          <span className="flex flex-wrap items-center gap-2">
            <Link className="font-mono text-12 font-semibold text-link hover:underline" href={requirementHref(slug, q.key)}>
              {q.key}
            </Link>
            <span className="min-w-0 flex-1 truncate">{q.title}</span>
            <StatusBadge family="requirement" value={q.state} />
            <span className="text-12 font-semibold" data-testid="completes">
              {q.completes ? "Completes it" : "Partial"}
            </span>
          </span>
          <span className="text-12-5 text-muted">
            {q.advances.length > 0 ? `Moves ${q.advances.map((a) => a.code).join(", ")}. ` : ""}
            {q.completes
              ? "Nothing else stands between it and done."
              : [
                  q.remaining.issues.length > 0 ? `Still open: ${q.remaining.issues.join(", ")}.` : "",
                  q.remaining.criteria.length > 0 ? `Not yet passing: ${q.remaining.criteria.join(", ")}.` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How the release is built, for the engineers: collapsed, so a reader of the release reads what users get first. */
function TechnicalDetail({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Technical detail" data-testid="release-technical">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="release-technical-toggle">
        Technical detail
      </DisclosureToggle>
      <span className="ml-2 text-12-5 text-muted">{changesSentence(r.changes)}</span>
      {open ? (
        <div className="mt-3">
          <TourHint tourId="release-what-changes" />
          <WhatChanges changes={r.changes} slug={slug} />
        </div>
      ) : null}
    </section>
  );
}

export function OverviewPane({ r, slug, all }: { r: ReleaseDetail; slug: string; all: ReleaseSummary[] }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8" data-testid="view-overview">
      <WhatUsersGet r={r} slug={slug} />
      <TechnicalDetail r={r} slug={slug} />
      {r.gates.length > 0 ? (
        <section aria-label="Why it cannot be cut">
          <ViewHeading hint={r.state === "draft" ? "Each reason holds the cut until it is answered" : undefined}>
            {r.state === "draft" ? "What stands in the way" : "Worth knowing"}
          </ViewHeading>
          <ul className="divide-y divide-line-subtle border-y border-line-subtle">
            {r.gates.map((g) => (
              <GateLine key={g.code} gate={g} slug={slug} />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="Release train" className="-mx-5">
        <ReleaseTrain releases={all} slug={slug} selected={r.key} />
      </section>
      <section aria-label="Requirements it completes">
        <ViewHeading hint="Done once this release ships, and what each still owes">Requirements it completes</ViewHeading>
        <Requirements r={r} slug={slug} />
      </section>
    </div>
  );
}

function issueGroups(issues: ReleaseIssueView[], titles: Map<string, string>): ListGroup<ReleaseIssueView>[] {
  const by = new Map<string, ReleaseIssueView[]>();
  for (const i of issues) by.set(i.requirement ?? MAINTENANCE, [...(by.get(i.requirement ?? MAINTENANCE) ?? []), i]);
  return [...by.entries()].map(([id, rows]) => ({ id: `req:${id}`, label: id, mono: id !== MAINTENANCE, hint: titles.get(id), rows }));
}

const issueRow =
  (slug: string) =>
  (i: ReleaseIssueView): ListRowView => ({
    key: i.key,
    href: issueHref(slug, i.key),
    title: i.title,
    facts: [
      ...(i.surfaces.length > 0
        ? [
            <span key="surfaces" className="inline-flex gap-1 align-middle" data-testid="issue-surfaces">
              {i.surfaces.map((s) => (
                <EnumBadge key={s} family="landingSurface" value={s} />
              ))}
            </span>,
          ]
        : []),
      ...(i.landing.source === "box" ? ["Paths read by a box"] : []),
      ...(i.section ? [i.section] : []),
      i.criteria.total === 0 ? RELEASE_PROOF_LABELS.unrecorded : `Criteria ${i.criteria.proven} of ${i.criteria.total} proven`,
    ],
    state: <StatusBadge family="issue" value={i.status} />,
    waitingOn: <WaitingOn w={i.waitingOn} />,
    owner: null,
    age: null,
  });

const UNCLASSIFIED = "unclassified" as const;
type SurfaceFilter = LandingSurface | typeof UNCLASSIFIED;

const matchesSurface = (i: ReleaseIssueView, f: SurfaceFilter | null) =>
  f === null || (f === UNCLASSIFIED ? i.unclassified : i.surfaces.includes(f));

export function IssuesPane({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const fold = useGroupFold(`web-v2:release-issues-fold:${r.key}`);
  const [surface, setSurface] = useState<SurfaceFilter | null>(null);
  const shown = useMemo(() => r.issues.filter((i) => matchesSurface(i, surface)), [r.issues, surface]);
  const groups = useMemo(
    () => issueGroups(shown, new Map(r.requirementsCompleted.map((q) => [q.key, q.title]))),
    [shown, r.requirementsCompleted],
  );
  const row = useMemo(() => issueRow(slug), [slug]);
  const filters: { value: SurfaceFilter; label: string; count: number }[] = [
    ...LANDING_SURFACES.map((s) => ({ value: s, label: LANDING_SURFACE_LABELS[s], count: r.issues.filter((i) => i.surfaces.includes(s)).length })),
    { value: UNCLASSIFIED, label: "Unclassified", count: r.issues.filter((i) => i.unclassified).length },
  ].filter((f) => f.count > 0);
  return (
    <div className="pb-16" data-testid="view-issues">
      {filters.length > 1 ? (
        <fieldset className="flex flex-wrap gap-2 px-8 py-3 max-md:px-4" aria-label="Filter by surface" data-testid="surface-filter">
          {filters.map((f) => (
            <FilterChip
              key={f.value}
              on={surface === f.value}
              onToggle={() => setSurface((cur) => (cur === f.value ? null : f.value))}
              count={f.count}
              testId={`surface-filter-${f.value}`}
            >
              {f.label}
            </FilterChip>
          ))}
        </fieldset>
      ) : null}
      <GroupedList
        ariaLabel="Issues in this release"
        groups={groups}
        fold={fold}
        row={row}
        selected={null}
        onPeek={(k) => window.location.assign(issueHref(slug, k))}
        empty="No issue is in this release."
        columns={{ meta: "" }}
      />
    </div>
  );
}

export function CriteriaPane({ r }: { r: ReleaseDetail }) {
  const withCriteria = r.issueCriteria.filter((i) => i.criteria.length > 0);
  if (withCriteria.length === 0) return <p className="text-13 text-subtle">No issue in this release records acceptance criteria.</p>;
  return (
    <div className="grid gap-7" data-testid="view-criteria">
      {withCriteria.map((i) => (
        <section key={i.key} aria-label={`${i.key} criteria`}>
          <FieldLabel>
            <span className="font-mono text-12 font-semibold text-link">{i.key}</span> <span className="text-fg">{i.title}</span>
          </FieldLabel>
          <ol className="border-t border-line-subtle">
            {i.criteria.map((c) => (
              <li key={c.n} className="flex items-start gap-3 border-b border-line-subtle py-2 text-13" data-testid="release-criterion">
                <span className="w-6 flex-none tabular-nums text-muted">{c.n}.</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">
                  {c.statement}
                  {c.bc ? <span className="ml-2 font-mono text-12 text-subtle">{c.bc}</span> : null}
                </span>
                <Tooltip
                  label={[c.identity, c.reason ? `Reason: ${c.reason}` : null, c.judgedAt ? `${c.judgedBy === "agent" ? "An agent" : "A person"}, ${new Date(c.judgedAt).toLocaleString()}` : null]
                    .filter(Boolean)
                    .join("\n") || "No verdict recorded yet"}
                  multiline
                >
                  <span>
                    <StatusBadge family="criterion" value={c.standing} />
                  </span>
                </Tooltip>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function NoteLine({ e }: { e: ReleaseNoteEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex gap-2" data-testid="release-note">
      <span className="w-[72px] flex-none font-mono text-12 text-link">{e.key}</span>
      <span className="min-w-0 flex-1">
        {e.userFacing}
        {e.technical ? (
          <>
            {" "}
            <DisclosureToggle
              open={open}
              onToggle={() => setOpen((o) => !o)}
              className="text-12"
              testId="release-note-technical-toggle"
            >
              Technical note
            </DisclosureToggle>
            {open ? (
              <span className="mt-1 block text-12-5 text-muted" data-testid="release-note-technical">
                {e.technical}
              </span>
            ) : null}
          </>
        ) : null}
      </span>
    </li>
  );
}

export function NotesPane({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const { sections, withoutNotes } = r.notes;
  if (sections.length === 0 && withoutNotes.length === 0) return <p className="text-13 text-subtle">No release notes yet.</p>;
  return (
    <div className="grid gap-6" data-testid="view-notes">
      {sections.map((s) => (
        <section key={s.section}>
          <ViewHeading>{s.section}</ViewHeading>
          <ul className="grid gap-2.5 text-13-5">
            {s.entries.map((e) => (
              <NoteLine key={e.key} e={e} />
            ))}
          </ul>
        </section>
      ))}
      {withoutNotes.length > 0 ? (
        <section>
          <ViewHeading hint="The project's master writes each note; a comment on the issue reaches it">Without a note</ViewHeading>
          <ul className="grid gap-1 text-13 text-muted">
            {withoutNotes.map((w) => (
              <li key={w.key}>
                <Link className="font-mono text-12 text-link hover:underline" href={issueHref(slug, w.key)}>
                  {w.key}
                </Link>{" "}
                {w.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
