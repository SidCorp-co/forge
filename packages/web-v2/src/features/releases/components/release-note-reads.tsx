"use client";

// Reads of a release's notes that are the operator's, not the reader's: which draft notes need
// rewriting before the cut, the designs it records apart (an approval changes nothing people use),
// and notes that call the build a demo while the release went to the project's production. They sit
// in the developer view; the reader's page (`release-reader.tsx`) says only what users get.

import { contentLanguageName } from "@forge/contracts/content-language";
import { notesCallingItDemo } from "@forge/contracts/customer-notes";
import Link from "next/link";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import type { ReleaseDetail } from "../types";

/** A language tag's name in the interface's own language (`vi` reads "Vietnamese", or its Vietnamese name). */
function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? contentLanguageName(tag);
  } catch {
    return contentLanguageName(tag);
  }
}

// A reader aid on the draft, not a gate: the release gate's own reasons are listed under "What stands
// in the way" and are not changed by this line. It counts the notes a user would read wrong.
export function NotesAttention({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const locale = useCopyLocale();
  const { attention, language } = r.notes;
  if (r.state !== "draft" || attention.length === 0) return null;
  const wrongLanguage = attention.filter((a) => a.notInLanguage).length;
  const technical = attention.filter((a) => a.references.length > 0).length;
  const n = attention.length;
  const name = languageName(language, locale);
  return (
    <p className="text-13 text-muted" data-testid="release-notes-attention">
      {t(n === 1 ? "releases.notesAttention.one" : "releases.notesAttention.many", { n, wrong: wrongLanguage, language: name, technical })}
      {" - "}
      {attention.map((a, i) => (
        <span key={a.key}>
          {i > 0 ? ", " : ""}
          <Link
            href={issueHref(slug, a.key)}
            title={[...(a.notInLanguage ? [t("releases.notInLanguage", { language: name })] : []), ...a.references].join("; ")}
            className="font-mono text-12-5 text-link hover:underline"
          >
            {a.key}
          </Link>
        </span>
      ))}
    </p>
  );
}

export function ApprovedDesigns({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  if (r.notes.designs.length === 0) return null;
  return (
    <div data-testid="release-designs-approved">
      <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle" title={t("releases.designsApprovedHint")}>
        {t("releases.designsApproved")}
      </h3>
      <ul className="border-t border-line-subtle">
        {r.notes.designs.map((e) => (
          <li key={e.key} className="flex flex-wrap items-baseline gap-x-2 border-b border-line-subtle py-2 text-13 text-muted">
            <span className="min-w-0 flex-1">{e.title}</span>
            <Link href={issueHref(slug, e.key)} className="font-mono text-11-5 text-subtle hover:text-link hover:underline">
              {e.key}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function DemoNotesWarning({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const demo = r.production ? notesCallingItDemo(r.notes.sections) : [];
  if (demo.length === 0) return null;
  const where = r.production?.url ? hostOf(r.production.url) : (r.production?.name ?? "");
  return (
    <p className="text-12-5 text-amber-700 dark:text-amber-300" data-testid="release-customer-demo">
      {t("releases.customer.demo", { n: demo.length, keys: demo.join(", "), where })}
    </p>
  );
}
