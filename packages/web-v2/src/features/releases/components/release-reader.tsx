"use client";

// The release as its reader reads it (REQ-40): the header, the highlights, what the release proves,
// improvements and fixes, what an admin must do, and what is still open. The same component draws a
// page in the app (a member, with links into the project) and a frozen page a share link opens (no
// links, tickets for its media), so the two cannot read differently.

import type { ReleasePage } from "@forge/contracts/release-page";
import Link from "next/link";
import { useState } from "react";
import { ViewHeading } from "@/design";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
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
    ["build", t("releases.page.header.build"), h.build ? shortSha(h.build) : t("releases.page.header.notCut")],
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

function Requirements({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  return (
    <section aria-label={t("releases.page.requirements.title")} data-testid="page-requirements">
      <ViewHeading>{t("releases.page.requirements.title")}</ViewHeading>
      {page.requirements.length === 0 ? (
        <p className="text-13 text-muted">{t("releases.page.requirements.none")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {page.requirements.map((r) => (
            <li key={r.key} className="grid gap-1 py-3 text-13" data-testid="page-requirement">
              <span className="flex flex-wrap items-baseline gap-2">
                {slug ? (
                  <Link className="font-mono text-12 font-semibold text-link hover:underline" href={requirementHref(slug, r.key)}>
                    {r.key}
                  </Link>
                ) : (
                  <span className="font-mono text-12 font-semibold">{r.key}</span>
                )}
                <span className="min-w-0 flex-1 font-semibold">{r.title}</span>
                <span className="text-12 text-muted">{r.completes ? t("releases.page.requirements.completes") : t("releases.page.requirements.advances")}</span>
              </span>
              {r.proven.length > 0 ? (
                <ul className="grid gap-0.5 text-12-5" data-testid="page-proven">
                  {r.proven.map((p) => (
                    <li key={p.code}>
                      <span className="mr-2 font-mono text-12 text-subtle">{p.code}</span>
                      {p.statement}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-12-5 text-muted">{t("releases.page.requirements.noneProven")}</span>
              )}
              {r.unproven > 0 ? (
                <span className="text-12-5 text-muted" data-testid="page-unproven">
                  {t("releases.page.requirements.unproven", { n: r.unproven })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
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
        <p className="text-13 text-muted">{t("releases.page.actions.none")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle">
          {page.actionRequired.map((a) => (
            <li key={`${a.kind}:${a.ref}`} className="grid gap-0.5 py-2.5 text-13" data-testid="page-action" data-kind={a.kind}>
              <span className="text-13-5">{a.sentence}</span>
              <span className="font-mono text-12 text-muted">{a.ref}</span>
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
              {k.reason ? <span className="text-12-5 text-muted">{k.reason}</span> : null}
              {k.elsewhere ? (
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
      <List title={t("releases.page.technical.migrations")} items={tech.migrations} testId="page-technical-migrations" />
      <List title={t("releases.page.technical.contracts")} items={tech.contracts} testId="page-technical-contracts" />
      <List title={t("releases.page.technical.dependencies")} items={tech.dependencies} testId="page-technical-dependencies" />
      <div data-testid="release-technical">
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-13" testId="release-technical-toggle">
          {t("releases.page.technical.changes")}
        </DisclosureToggle>
        <span className="ml-2 text-12-5 text-muted">{changesSentence(tech.changes, t, label)}</span>
        {open ? (
          <div className="mt-3">
            <WhatChanges changes={tech.changes} {...(slug ? { slug } : {})} />
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
