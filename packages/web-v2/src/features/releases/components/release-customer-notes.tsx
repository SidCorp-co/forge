"use client";

// The release notes as a customer is handed them (`@forge/contracts/customer-notes`): each change
// once, in its section, with no issue key, internal title or path, to copy or save as Markdown.
// Beside the view, never in it: the notes held back for their writer to rewrite, the ones folded
// into the change they ship, and the notes that call the build a demo while the release went to
// the project's production.

import { customerNotes, customerNotesText, notesCallingItDemo } from "@forge/contracts/customer-notes";
import { useMemo, useState } from "react";
import { Button, ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ReleaseDetail } from "../types";

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function CustomerNotes({ r }: { r: ReleaseDetail }) {
  const t = useCopy();
  const view = useMemo(() => customerNotes(r.notes.sections), [r.notes.sections]);
  const text = useMemo(() => customerNotesText(r.version, view), [r.version, view]);
  const demo = r.production ? notesCallingItDemo(r.notes.sections) : [];
  const where = r.production?.url ? hostOf(r.production.url) : (r.production?.name ?? "");
  const [copied, setCopied] = useState(false);
  if (view.sections.length === 0 && view.held.length === 0) return null;
  return (
    <section className="grid gap-3 border-b border-line-subtle pb-6" data-testid="release-customer-notes">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <ViewHeading hint={t("releases.customer.hint")}>{t("releases.customer.title")}</ViewHeading>
        </div>
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
          {copied ? t("releases.customer.copied") : t("releases.customer.copy")}
        </Button>
        <Button size="sm" onClick={() => save(`release-${r.version}-notes.md`, text)}>
          {t("releases.customer.export")}
        </Button>
      </div>
      {demo.length > 0 ? (
        <p className="text-12-5 text-amber-700 dark:text-amber-300" data-testid="release-customer-demo">
          {t("releases.customer.demo", { n: demo.length, keys: demo.join(", "), where })}
        </p>
      ) : null}
      <div className="grid gap-3" data-testid="release-customer-view">
        {view.sections.map((s) => (
          <div key={s.section}>
            <h3 className="mb-1 text-12 font-semibold uppercase tracking-wide text-subtle">{s.section}</h3>
            <ul className="grid gap-1.5 text-13-5">
              {s.lines.map((line) => (
                <li key={line} data-testid="release-customer-line">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {view.held.length > 0 ? (
        <p className="text-12-5 text-muted" data-testid="release-customer-held">
          {t("releases.customer.held", { n: view.held.length, keys: view.held.map((h) => `${h.key} (${h.references.join(", ")})`).join("; ") })}
        </p>
      ) : null}
      {view.folded.length > 0 ? (
        <p className="text-12-5 text-muted" data-testid="release-customer-folded">
          {t("releases.customer.folded", { n: view.folded.length, keys: view.folded.map((f) => `${f.key} → ${f.into.join(", ")}`).join("; ") })}
        </p>
      ) : null}
    </section>
  );
}
