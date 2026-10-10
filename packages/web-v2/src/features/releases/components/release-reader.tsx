"use client";

// The release as its reader reads it (REQ-40): the header, the highlights, what the release proves,
// improvements and fixes, what an admin must do, and what is still open. The same component draws a
// page in the app (a member, with links into the project) and a frozen page a share link opens (no
// links, tickets for its media), so the two cannot read differently. What the release proves draws
// each requirement's outcome and each proven criterion as a mark, with the counts in its filter pills
// (REQ-43 BC-10); the build, criterion codes and each requirement's own count are the developer
// view's (BC-7).

import { actionSaysRef, type ReleasePage, type ReleasePageCriteria, type ReleasePageProven, type ReleasePageRequirement } from "@forge/contracts/release-page";
import Link from "next/link";
import { useState } from "react";
import { FilterChip, ViewHeading } from "@/design";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { withoutCriterionCode } from "@/lib/utils/criterion-code";
import { verifiedSentence } from "../verified";
import { DisclosureToggle, shortSha } from "./release-bits";
import { changesSentence, WhatChanges } from "./release-changes";
import { ReleaseHighlightsSection } from "./release-highlights";

const RULED = "border-b border-line-subtle pb-6";

function ReleaseHeader({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const time = useTimeFormat();
  const h = page.header;
  const a = h.approval;
  const who = a.by?.name ?? "";
  const approval =
    a.state === "approved" && a.by
      ? a.at
        ? t("releases.page.approval.approvedAt", { who, at: time.date(a.at) })
        : t("releases.page.approval.approved", { who })
      : t(`releases.page.approval.${a.state}`);
  const rows: [string, string, string][] = [
    ["released", t("releases.page.header.released"), h.releasedAt ? time.dateTime(h.releasedAt) : t("releases.page.header.notReleased")],
    ["runs-at", t("releases.page.header.runsAt"), h.environment ? (h.environment.url ?? h.environment.name ?? t("releases.page.header.notDeployed")) : t("releases.page.header.notDeployed")],
    // the build is a sha: agent text, the developer view's
    ...(page.view === "developer" ? [["build", t("releases.page.header.build"), h.build ? shortSha(h.build) : t("releases.page.header.notCut")] as [string, string, string]] : []),
    ["verified", t("releases.page.header.verified"), verifiedSentence(h.verified, t)],
    ["approval", t("releases.page.header.approval"), approval],
  ];
  return (
    <section aria-label={`${t("releases.page.header.released")} ${h.version}`} className={RULED} data-testid="page-header">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-13">
        {rows.map(([key, label, value]) => (
          <div key={key} className="contents" data-testid={`page-header-${key}`}>
            <dt className="text-muted">{label}</dt>
            <dd className={key === "build" ? "font-mono text-12-5" : undefined} data-level={key === "verified" ? h.verified.level : undefined} data-state={key === "approval" ? a.state : undefined}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const rowKey = (p: ReleasePageProven) => `${p.issueKey ?? ""}:${p.n ?? p.statement}:${p.code ?? ""}`;

/** One proven row: a mark, the criterion's own wording, named by its issue and number in the developer view; a short marked apart. */
function ProvenRow({ p, label, developer }: { p: ReleasePageProven; label: string | null; developer: boolean }) {
  const t = useCopy();
  const word = p.short ? t("releases.page.requirements.short") : t("releases.page.requirements.proven");
  return (
    <li data-testid="page-proven-row">
      <span role="img" aria-label={word} title={word} className="mr-2 inline-block w-3 text-center font-semibold text-[var(--wf-green)]" data-testid={p.short ? "page-proven-short" : "page-proven-mark"}>
        {p.short ? "≈" : "✓"}
      </span>
      {label ? <span className="mr-2 font-mono text-12 text-subtle">{label}</span> : null}
      {developer ? p.statement : withoutCriterionCode(p.statement)}
    </li>
  );
}

const nameOf = (p: ReleasePageProven) => (p.issueKey && p.n !== null ? `${p.issueKey} #${p.n}` : (p.code ?? p.issueKey));

/** One group's carried criteria: each proven one (a short marked, one tracing no code under its issue's key), then, in the developer view, how many are not. */
function Criteria({ group, developer }: { group: ReleasePageCriteria; developer: boolean }) {
  const t = useCopy();
  return (
    <>
      {group.proven.length > 0 ? (
        <ul className="grid gap-0.5 text-12-5" data-testid="page-proven">
          {group.proven.map((p) => (
            <ProvenRow key={rowKey(p)} p={p} label={developer ? nameOf(p) : null} developer={developer} />
          ))}
        </ul>
      ) : (
        <span className="text-12-5 text-muted">{t("releases.page.requirements.noneProven")}</span>
      )}
      {developer && group.unproven > 0 ? (
        <span className="text-12-5 text-muted" data-testid="page-unproven" data-n={group.unproven}>
          {t("releases.page.requirements.unproven", { n: group.unproven })}
        </span>
      ) : null}
    </>
  );
}

/**
 * A requirement counted in its own criteria (BC-5): how many of them the build proves, then each one
 * said once with the issue criteria under it that prove it, so seven rows tracing one read apart.
 */
function RequirementCriteria({ r, developer }: { r: ReleasePageRequirement; developer: boolean }) {
  const t = useCopy();
  if (!r.business) return <Criteria group={r} developer={developer} />;
  const codes = new Set(r.business.proven.map((c) => c.code));
  const rest = r.proven.filter((p) => p.code === null || !codes.has(p.code));
  return (
    <>
      {developer ? (
        <span className="text-12-5 text-muted" data-testid="page-requirement-count" data-proven={r.business.proven.length} data-total={r.business.total}>
          {t("releases.page.requirements.count", { proven: r.business.proven.length, total: r.business.total })}
        </span>
      ) : null}
      {r.business.proven.length + rest.length > 0 ? (
        <ul className="grid gap-1.5 text-12-5" data-testid="page-proven">
          {r.business.proven.map((c) => (
            <li key={c.code} data-testid="page-proven-code" data-code={c.code}>
              {developer ? <span className="mr-2 font-mono text-12 text-subtle">{c.code}</span> : null}
              <span className="font-semibold">{c.statement}</span>
              <ul className="mt-0.5 grid gap-0.5 pl-4">
                {r.proven
                  .filter((p) => p.code === c.code)
                  .map((p) => (
                    <ProvenRow key={rowKey(p)} p={p} label={developer && p.issueKey && p.n !== null ? `${p.issueKey} #${p.n}` : null} developer={developer} />
                  ))}
              </ul>
            </li>
          ))}
          {rest.map((p) => (
            <ProvenRow key={rowKey(p)} p={p} label={developer ? nameOf(p) : null} developer={developer} />
          ))}
        </ul>
      ) : (
        <span className="text-12-5 text-muted">{t("releases.page.requirements.noneProven")}</span>
      )}
    </>
  );
}

type Outcome = "completes" | "advances";

/** A requirement's outcome on this build as one mark, named on it: it completes, or it moves forward. */
function OutcomeMark({ completes }: { completes: boolean }) {
  const t = useCopy();
  const word = completes ? t("releases.page.requirements.completes") : t("releases.page.requirements.advances");
  return (
    <span role="img" aria-label={word} title={word} className="w-4 flex-none text-center font-semibold text-muted" data-testid="page-requirement-mark" data-outcome={completes ? "completes" : "advances"}>
      {completes ? "✓" : "→"}
    </span>
  );
}

function Requirements({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  const developer = page.view === "developer";
  const [filter, setFilter] = useState<Outcome | "all">("all");
  const of = (o: Outcome) => page.requirements.filter((r) => r.completes === (o === "completes")).length;
  const shown = page.requirements.filter((r) => filter === "all" || r.completes === (filter === "completes"));
  return (
    <section aria-label={t("releases.page.requirements.title")} data-testid="page-requirements">
      <ViewHeading>{t("releases.page.requirements.title")}</ViewHeading>
      {page.requirements.length === 0 && !page.untraced ? (
        <p className="text-13 text-muted">{t("releases.page.requirements.none")}</p>
      ) : (
        <>
        {page.requirements.length > 0 ? (
          <fieldset className="m-0 mb-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0" aria-label={t("releases.page.requirements.show")} data-testid="page-requirements-filter">
            <FilterChip on={filter === "all"} onToggle={() => setFilter("all")} count={page.requirements.length} testId="page-requirements-filter-all">
              {t("releases.page.requirements.all")}
            </FilterChip>
            {(["completes", "advances"] as const)
              .filter((o) => of(o) > 0)
              .map((o) => (
                <FilterChip key={o} on={filter === o} onToggle={() => setFilter(filter === o ? "all" : o)} count={of(o)} testId={`page-requirements-filter-${o}`}>
                  {t(`releases.page.requirements.${o}`)}
                </FilterChip>
              ))}
          </fieldset>
        ) : null}
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {shown.map((r) => (
            <li key={r.key} className="grid gap-1 py-3 text-13" data-testid="page-requirement">
              <span className="flex flex-wrap items-baseline gap-2">
                <OutcomeMark completes={r.completes} />
                {slug ? (
                  <Link className="font-mono text-12 font-semibold text-link hover:underline" href={requirementHref(slug, r.key)}>
                    {r.key}
                  </Link>
                ) : (
                  <span className="font-mono text-12 font-semibold">{r.key}</span>
                )}
                <span className="min-w-0 flex-1 font-semibold">{r.title}</span>
              </span>
              <RequirementCriteria r={r} developer={developer} />
            </li>
          ))}
          {page.untraced ? (
            <li className="grid gap-1 py-3 text-13" data-testid="page-untraced">
              <span className="font-semibold">{t("releases.page.requirements.untraced")}</span>
              <Criteria group={page.untraced} developer={developer} />
            </li>
          ) : null}
        </ul>
        </>
      )}
    </section>
  );
}

function Changes({ title, lines, testId, markNew }: { title: string; lines: ReleasePage["improvements"]; testId: string; markNew?: boolean }) {
  const t = useCopy();
  if (lines.length === 0) return null;
  return (
    <section aria-label={title} data-testid={testId}>
      <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle">{title}</h3>
      <ul className="divide-y divide-line-subtle border-y border-line-subtle">
        {lines.map((c) => (
          <li key={`${c.issueKey}:${c.line}`} className="py-2.5 text-13-5" data-testid="page-change" data-kind={c.kind}>
            {markNew && c.kind === "new" ? <span className="mr-2 text-12 font-semibold text-accent-text">{t("releases.page.improvements.new")}</span> : null}
            {c.line}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Unnoted({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const n = page.withoutNotes.length;
  if (n === 0) return null;
  return (
    <div data-testid="page-unnoted">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="page-unnoted-toggle">
        {t(n === 1 ? "releases.page.unnoted.one" : "releases.page.unnoted.many", { n })}
      </DisclosureToggle>
      {open ? (
        <ul className="mt-1.5 border-t border-line-subtle">
          {page.withoutNotes.map((w) => (
            <li key={w.issueKey} className="flex flex-wrap items-baseline gap-x-2 py-2 text-13 text-muted">
              <span className="min-w-0 flex-1">
                {w.title} <span className="text-12 text-subtle">({t(`releases.page.unnoted.${w.why}`)})</span>
              </span>
              {slug ? (
                <Link href={issueHref(slug, w.issueKey)} className="font-mono text-11-5 text-subtle hover:text-link hover:underline">
                  {w.issueKey}
                </Link>
              ) : (
                <span className="font-mono text-11-5 text-subtle">{w.issueKey}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ActionRequired({ page }: { page: ReleasePage }) {
  const t = useCopy();
  return (
    <section aria-label={t("releases.page.actions.title")} data-testid="page-actions">
      <ViewHeading>{t("releases.page.actions.title")}</ViewHeading>
      {page.actionRequired.length === 0 ? (
        <p className="text-13 text-muted" data-testid="page-actions-none" data-read={page.shipped.state}>
          {page.shipped.state === "unread" ? t("releases.page.actions.unread", { why: page.shipped.why }) : t("releases.page.actions.none")}
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {page.actionRequired.map((a) => (
            <li key={`${a.kind}:${a.ref}`} className="grid gap-0.5 py-2.5 text-13" data-testid="page-action" data-kind={a.kind}>
              <span className="text-13-5">{a.sentence}</span>
              {actionSaysRef(a) ? null : <span className="font-mono text-12 text-muted">{a.ref}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KnownIssues({ page }: { page: ReleasePage }) {
  const t = useCopy();
  return (
    <section aria-label={t("releases.page.known.title")} data-testid="page-known-issues">
      <ViewHeading>{t("releases.page.known.title")}</ViewHeading>
      {page.knownIssues.length === 0 ? (
        <p className="text-13 text-muted">{t("releases.page.known.none")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {page.knownIssues.map((k) => (
            <li key={`${k.issueKey}:${k.statement}`} className="grid gap-0.5 py-2.5 text-13" data-testid="page-known-issue" data-standing={k.standing}>
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="min-w-0 flex-1 text-13-5">{k.statement}</span>
                <span className="text-12 font-semibold">{t(`releases.page.known.${k.standing}`)}</span>
              </span>
              {page.view === "developer" && k.reason ? <span className="text-12-5 text-muted">{k.reason}</span> : null}
              {page.view === "developer" && k.elsewhere ? (
                <span className="text-12-5 text-muted">
                  {t("releases.page.known.elsewhere", { verdict: k.elsewhere.verdict, build: k.elsewhere.commitSha ? shortSha(k.elsewhere.commitSha) : "-" })}
                </span>
              ) : null}
              {k.requirementKey ? (
                <span className="font-mono text-11-5 text-subtle">
                  {k.requirementKey}
                  {k.bc ? ` ${k.bc}` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function List({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  const t = useCopy();
  return (
    <div data-testid={testId}>
      <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle">{title}</h3>
      {items.length === 0 ? (
        <p className="text-13 text-muted">{t("releases.page.technical.none")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {items.map((i) => (
            <li key={i} className="break-all py-1.5 font-mono text-12-5">
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The developer view's addition (BC-9): never drawn from a page that carries none. */
function Technical({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  const label = useLabel();
  const [open, setOpen] = useState(false);
  const tech = page.technical;
  if (!tech) return null;
  return (
    <section aria-label={t("releases.page.technical.title")} className="grid gap-5" data-testid="page-technical">
      <ViewHeading>{t("releases.page.technical.title")}</ViewHeading>
      <div data-testid="page-technical-notes">
        <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle">{t("releases.page.technical.notes")}</h3>
        {tech.notes.length === 0 ? (
          <p className="text-13 text-muted">{t("releases.page.technical.none")}</p>
        ) : (
          <ul className="divide-y divide-line-subtle border-y border-line-subtle">
            {tech.notes.map((n) => (
              <li key={n.issueKey} className="grid gap-0.5 py-2.5 text-13">
                <span className="flex items-baseline gap-2">
                  {slug ? (
                    <Link href={issueHref(slug, n.issueKey)} className="font-mono text-12 text-link hover:underline">
                      {n.issueKey}
                    </Link>
                  ) : (
                    <span className="font-mono text-12">{n.issueKey}</span>
                  )}
                  <span className="font-semibold">{n.title}</span>
                </span>
                <span className="text-12-5 text-muted">{n.technical}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-12-5 text-muted" data-testid="page-technical-range" data-read={page.shipped.state}>
        {page.shipped.state === "read"
          ? t("releases.page.technical.range", { base: shortSha(page.shipped.base), head: shortSha(page.shipped.head) })
          : t("releases.page.technical.unread", { why: page.shipped.why })}
      </p>
      <List title={t("releases.page.technical.migrations")} items={tech.migrations} testId="page-technical-migrations" />
      <List title={t("releases.page.technical.contracts")} items={tech.contracts} testId="page-technical-contracts" />
      <List title={t("releases.page.technical.dependencies")} items={tech.dependencies} testId="page-technical-dependencies" />
      <List title={t("releases.page.technical.settings")} items={tech.settings} testId="page-technical-settings" />
      <div data-testid="release-technical">
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="release-technical-toggle">
          {t("releases.page.technical.changes")}
        </DisclosureToggle>
        <span className="ml-2 text-12-5 text-muted">{changesSentence(tech.changes, t, label)}</span>
        {open ? (
          <div className="mt-3">
            <WhatChanges changes={tech.changes} headed={false} {...(slug ? { slug } : {})} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * `slug` is set where the reader is a member in the app (keys link into the project); `authed` says
 * the media are issue attachments behind the session rather than tickets a share link minted.
 */
export function ReleaseReader({ page, slug, authed }: { page: ReleasePage; slug?: string | undefined; authed: boolean }) {
  const t = useCopy();
  return (
    <div className="grid gap-6" data-testid="release-reader" data-view={page.view} data-tour="rel-users">
      <ReleaseHeader page={page} />
      <ReleaseHighlightsSection highlights={page.highlights} slug={slug} authed={authed} />
      <Requirements page={page} slug={slug} />
      {page.improvements.length + page.fixes.length + page.withoutNotes.length > 0 ? (
        <div className="grid gap-5" data-testid="page-changes">
          <Changes title={t("releases.page.improvements.title")} lines={page.improvements} testId="page-improvements" markNew />
          <Changes title={t("releases.page.fixes.title")} lines={page.fixes} testId="page-fixes" />
          <Unnoted page={page} slug={slug} />
        </div>
      ) : null}
      <ActionRequired page={page} />
      <KnownIssues page={page} />
      <Technical page={page} slug={slug} />
    </div>
  );
}
