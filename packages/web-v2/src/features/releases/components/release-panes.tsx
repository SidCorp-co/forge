"use client";

import { LANDING_SURFACES, type LandingSurface } from "@forge/contracts/landing-artifacts";
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
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { issueHref } from "@/lib/routes/issues";
import { feedbackHref } from "@/lib/routes/feedback";
import { requirementHref } from "@/lib/routes/requirements";
import type { ReleaseDetail, ReleaseFeedbackView, ReleaseIssueView, ReleaseNoteEntry, ReleaseSummary } from "../types";
import { DisclosureToggle, GateLine } from "./release-bits";
import { TourHint } from "@/features/tours/components/tour-hint";
import { changesSentence, WhatChanges } from "./release-changes";
import { CustomerNotes } from "./release-customer-notes";
import { WhatUsersGet } from "./release-users-get";
import { ReleaseTrain } from "./release-train";

export const RELEASE_TABS = ["overview", "issues", "criteria", "checks", "notes"] as const;
export type ReleaseTab = (typeof RELEASE_TABS)[number];

const MAINTENANCE = "Maintenance";

function Requirements({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  if (r.requirementsCompleted.length === 0) {
    return <p className="text-13 text-subtle">{t("releases.noRequirement")}</p>;
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
              {q.completes ? t("releases.completesIt") : t("releases.partial")}
            </span>
          </span>
          <span className="text-12-5 text-muted">
            {q.advances.length > 0 ? `${t("releases.moves", { codes: q.advances.map((a) => a.code).join(", ") })} ` : ""}
            {q.completes
              ? t("releases.nothingElse")
              : [
                  q.remaining.issues.length > 0 ? t("releases.stillOpen", { keys: q.remaining.issues.join(", ") }) : "",
                  q.remaining.criteria.length > 0 ? t("releases.notYetPassing", { codes: q.remaining.criteria.join(", ") }) : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

const TOLD: Record<ReleaseFeedbackView["told"], (f: ReleaseFeedbackView, t: Copy, stamp: (at: string) => string) => string> = {
  on_ship: (_f, t) => t("releases.toldOnShip"),
  told: (f, t, stamp) => (f.toldAt ? t("releases.toldAt", { at: stamp(f.toldAt) }) : t("releases.told")),
  not_told: (f, t) => (f.agency === "agent" ? t("releases.notToldAgent") : t("releases.notTold")),
  before_notices: (_f, t) => t("releases.toldBeforeNotices"),
};

/** The feedback the release answers: who asked, and whether this release told them. Flush rows, no cards. */
export function FeedbackAnswered({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (r.feedbackAnswered.length === 0) return null;
  return (
    <section aria-label={t("releases.feedbackAnswered")} data-testid="release-feedback">
      <ViewHeading hint={t("releases.feedbackAnsweredHint")}>{t("releases.feedbackAnswered")}</ViewHeading>
      <p className="mb-2 text-12-5 text-muted" data-testid="release-feedback-counts">
        {(["told", "not_told", "before_notices", "on_ship"] as const)
          .filter((k) => r.feedbackToldCounts[k] > 0)
          .map((k) => t(`releases.toldCount.${k}`, { n: r.feedbackToldCounts[k] }))
          .join(" · ")}
      </p>
      <ul className="border-t border-line-subtle">
        {r.feedbackAnswered.map((f) => (
          <li key={f.key} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid="release-feedback-row" data-told={f.told}>
            <span className="flex flex-wrap items-center gap-2">
              <Link className="font-mono text-12 font-semibold text-link hover:underline" href={feedbackHref(slug, f.key)}>
                {f.key}
              </Link>
              <span className="min-w-0 flex-1 truncate">{f.title}</span>
            </span>
            <span className="text-12-5 text-muted">
              {f.reporter} · {TOLD[f.told](f, t, time.dateTime)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How the release is built, for the engineers: collapsed, so a reader of the release reads what users get first. */
function TechnicalDetail({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const label = useLabel();
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={t("releases.technicalDetail")} data-testid="release-technical" data-tour="rel-technical">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="release-technical-toggle">
        {t("releases.technicalDetail")}
      </DisclosureToggle>
      <span className="ml-2 text-12-5 text-muted">{changesSentence(r.changes, t, label)}</span>
      {open ? (
        <div className="mt-3">
          <WhatChanges changes={r.changes} slug={slug} />
        </div>
      ) : null}
    </section>
  );
}

export function OverviewPane({ r, slug, all }: { r: ReleaseDetail; slug: string; all: ReleaseSummary[] }) {
  const t = useCopy();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8" data-testid="view-overview">
      <div>
        <TourHint tourId="release-what-changes" />
        <WhatUsersGet r={r} slug={slug} />
      </div>
      <FeedbackAnswered r={r} slug={slug} />
      <TechnicalDetail r={r} slug={slug} />
      {r.gates.length > 0 ? (
        <section aria-label={t("releases.whyNotCut")}>
          <ViewHeading hint={r.state === "draft" ? t("releases.inTheWayHint") : undefined}>
            {r.state === "draft" ? t("releases.inTheWay") : t("releases.worthKnowing")}
          </ViewHeading>
          <ul className="divide-y divide-line-subtle border-y border-line-subtle">
            {r.gates.map((g) => (
              <GateLine key={g.code} gate={g} slug={slug} />
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label={t("releases.train")} className="-mx-5">
        <ReleaseTrain releases={all} slug={slug} selected={r.key} />
      </section>
      <section aria-label={t("releases.requirementsCompletes")}>
        <ViewHeading hint={t("releases.requirementsCompletesHint")}>{t("releases.requirementsCompletes")}</ViewHeading>
        <Requirements r={r} slug={slug} />
      </section>
    </div>
  );
}

function issueGroups(issues: ReleaseIssueView[], titles: Map<string, string>, t: Copy): ListGroup<ReleaseIssueView>[] {
  const by = new Map<string | null, ReleaseIssueView[]>();
  for (const i of issues) by.set(i.requirement, [...(by.get(i.requirement) ?? []), i]);
  return [...by.entries()].map(([id, rows]) => ({
    id: `req:${id ?? MAINTENANCE}`,
    label: id ?? t("releases.maintenance"),
    mono: id !== null,
    hint: id === null ? undefined : titles.get(id),
    rows,
  }));
}

const issueRow =
  (slug: string, t: Copy, label: ReturnType<typeof useLabel>) =>
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
      ...(i.landing.source === "box" ? [t("releases.pathsByBox")] : []),
      ...(i.section ? [i.section] : []),
      i.criteria.total === 0 ? label("releaseProof", "unrecorded") : t("releases.criteriaProven", { proven: i.criteria.proven, total: i.criteria.total }),
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
  const t = useCopy();
  const label = useLabel();
  const fold = useGroupFold(`web-v2:release-issues-fold:${r.key}`);
  const [surface, setSurface] = useState<SurfaceFilter | null>(null);
  const shown = useMemo(() => r.issues.filter((i) => matchesSurface(i, surface)), [r.issues, surface]);
  const groups = useMemo(
    () => issueGroups(shown, new Map(r.requirementsCompleted.map((q) => [q.key, q.title])), t),
    [shown, r.requirementsCompleted, t],
  );
  const row = useMemo(() => issueRow(slug, t, label), [slug, t, label]);
  const filters: { value: SurfaceFilter; label: string; count: number }[] = [
    ...LANDING_SURFACES.map((s) => ({ value: s, label: label("landingSurface", s), count: r.issues.filter((i) => i.surfaces.includes(s)).length })),
    { value: UNCLASSIFIED, label: t("releases.unclassified"), count: r.issues.filter((i) => i.unclassified).length },
  ].filter((f) => f.count > 0);
  return (
    <div className="pb-16" data-testid="view-issues">
      {filters.length > 1 ? (
        <fieldset className="flex flex-wrap gap-2 px-8 py-3 max-md:px-4" aria-label={t("releases.filterBySurface")} data-testid="surface-filter">
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
        ariaLabel={t("releases.issuesInRelease")}
        groups={groups}
        fold={fold}
        row={row}
        selected={null}
        onPeek={(k) => window.location.assign(issueHref(slug, k))}
        empty={t("releases.noIssueIn")}
        columns={{ meta: "" }}
      />
    </div>
  );
}

export function CriteriaPane({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const time = useTimeFormat();
  const withCriteria = r.issueCriteria.filter((i) => i.criteria.length > 0);
  if (withCriteria.length === 0) return <p className="text-13 text-subtle">{t("releases.criteriaEmpty")}</p>;
  return (
    <div className="grid gap-7" data-testid="view-criteria">
      {withCriteria.map((i) => (
        <section key={i.key} aria-label={t("releases.keyCriteria", { key: i.key })}>
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
                  label={[c.identity, c.reason ? `${t("releases.reason")} ${c.reason}` : null, c.judgedAt ? `${c.judgedBy === "agent" ? t("releases.anAgent") : t("releases.aPerson")}, ${time.dateTime(c.judgedAt)}` : null]
                    .filter(Boolean)
                    .join("\n") || t("releases.noVerdict")}
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
  const t = useCopy();
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
              {t("releases.technicalNote")}
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
  const t = useCopy();
  const { sections, withoutNotes } = r.notes;
  if (sections.length === 0 && withoutNotes.length === 0) return <p className="text-13 text-subtle">{t("releases.notesEmpty")}</p>;
  return (
    <div className="grid gap-6" data-testid="view-notes">
      <CustomerNotes r={r} />
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
          <ViewHeading hint={t("releases.withoutNoteHint")}>{t("releases.withoutNote")}</ViewHeading>
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
