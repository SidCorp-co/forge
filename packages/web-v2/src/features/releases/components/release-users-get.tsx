"use client";

// What a release gives the people who use the product, ahead of how it is built: each issue's
// user-facing release note under the CHANGELOG section it belongs to, named by its title. The
// engineers' view (surfaces, artifacts, unclassified landings) sits below it, collapsed.

import { contentLanguageName } from "@forge/contracts/content-language";
import Link from "next/link";
import { useState } from "react";
import { ViewHeading } from "@/design";
import { issueHref } from "@/lib/routes/issues";
import type { ReleaseDetail } from "../types";
import { DisclosureToggle } from "./release-bits";

// A reader aid on the draft, not a gate: the release gate's own reasons are listed under "What stands
// in the way" and are not changed by this line. It counts the notes a user would read wrong.
function NotesAttention({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const { attention, language } = r.notes;
  if (r.state !== "draft" || attention.length === 0) return null;
  const wrongLanguage = attention.filter((a) => a.notInLanguage).length;
  const technical = attention.filter((a) => a.references.length > 0).length;
  const n = attention.length;
  return (
    <p className="text-13 text-muted" data-testid="release-notes-attention">
      {n === 1 ? "1 note needs" : `${n} notes need`} attention before release: {wrongLanguage} not in {contentLanguageName(language)}, {technical} carry technical references
      {" - "}
      {attention.map((a, i) => (
        <span key={a.key}>
          {i > 0 ? ", " : ""}
          <Link
            href={issueHref(slug, a.key)}
            title={[...(a.notInLanguage ? [`not in ${contentLanguageName(language)}`] : []), ...a.references].join("; ")}
            className="font-mono text-12-5 text-link hover:underline"
          >
            {a.key}
          </Link>
        </span>
      ))}
    </p>
  );
}

export function WhatUsersGet({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const { sections, withoutNotes } = r.notes;
  const [open, setOpen] = useState(false);
  const noted = sections.reduce((n, s) => n + s.entries.length, 0);
  return (
    <section aria-label="What users get" data-testid="release-users-get" data-tour="rel-users" className="grid gap-5">
      <NotesAttention r={r} slug={slug} />
      <ViewHeading hint="Each change as the people who use the product will read it">What users get</ViewHeading>
      {noted === 0 ? (
        <p className="text-13 text-muted" data-testid="release-users-get-empty">
          {r.issues.length === 0 ? "No change is in this release." : "No change in this release has a note for users yet."}
        </p>
      ) : (
        sections.map((s) => (
          <div key={s.section} data-testid="release-users-section" data-section={s.section}>
            <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle">{s.section}</h3>
            <ul className="border-t border-line-subtle">
              {s.entries.map((e) => (
                <li key={e.key} className="grid gap-0.5 border-b border-line-subtle py-2.5" data-testid="release-users-entry">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 flex-1 text-13-5 font-semibold">{e.title}</span>
                    <Link href={issueHref(slug, e.key)} className="font-mono text-11-5 text-subtle hover:text-link hover:underline">
                      {e.key}
                    </Link>
                  </span>
                  <span className="text-13 text-muted">{e.userFacing}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {withoutNotes.length > 0 ? (
        <div data-testid="release-users-without">
          <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="release-users-without-toggle">
            {withoutNotes.length === 1 ? "1 change has no note for users yet" : `${withoutNotes.length} changes have no note for users yet`}
          </DisclosureToggle>
          {open ? (
            <ul className="mt-1.5 border-t border-line-subtle">
              {withoutNotes.map((w) => (
                <li key={w.key} className="flex flex-wrap items-baseline gap-x-2 border-b border-line-subtle py-2 text-13 text-muted">
                  <span className="min-w-0 flex-1">{w.title}</span>
                  <Link href={issueHref(slug, w.key)} className="font-mono text-11-5 text-subtle hover:text-link hover:underline">
                    {w.key}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
