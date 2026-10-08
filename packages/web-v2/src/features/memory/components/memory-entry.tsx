"use client";

// One memory on the record it names (MJ-1, MJ-3, REQ-33 BC-4): what it says, who wrote it and when, whether anyone
// checked it, why it needs a check (core's reasons: unchecked too long, a cited record changed since),
// which records it names that no longer exist, a release's "may be outdated" flag read
// as the guess it is, every correction or retirement with its reason, and the text it held before each
// body that replaced it (ISS-434), its writer named as the one who wrote it, never the corrector.
// "Still true" stamps the row checked by the person; "Not true anymore" leads to Correct or Retire, which each take a reason before they send; a mirror of an issue, comment or job offers neither.

import { MEMORY_CHECK_AFTER_DAYS, MEMORY_MIRROR_SOURCES, type MemoryActor, type MemoryArchiveCause, type MemoryCite, type MemoryEntry, type MemoryStaleRef } from "@forge/contracts/memory";
import Link from "next/link";
import { Fragment, type ReactNode, useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { formatDate } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { Written } from "@/lib/i18n/written";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";

/** A reason short enough to be a word is not one; core holds the same floor. */
const REASON_MIN = 3;

type Mode = "read" | "untrue" | "correct" | "retire";

export interface MemoryEntryRowProps {
  entry: MemoryEntry;
  slug: string;
  timeZone?: string;
  busy: boolean;
  /** "Still true": this memory was checked and holds. */
  onVerify: (id: string) => void;
  onCorrect: (id: string, body: { text: string; reason: string }) => void;
  onRetire: (id: string, body: { reason: string }) => void;
}

function actorName(t: Copy, a: MemoryActor | null): string {
  if (!a) return t("memory.writerUnknown");
  return a.agent ? t("memory.agentName", { name: a.name }) : a.name;
}

function staleWhy(t: Copy, r: MemoryStaleRef): string {
  if (r.why === "missing") return t(`memory.why.missing.${r.kind}`);
  return t(`memory.why.${r.why}` as ProductCopyKey);
}

/** Why decay or a verdict archived a row, in the reader's words; evidence and recorded text stay as written. */
function archivedLine(t: Copy, cause: MemoryArchiveCause | null, date: string): ReactNode {
  if (!cause) return t("memory.archivedUnknown", { date });
  if (cause.rule === "unused") return t("memory.archived.unused", { date });
  if (cause.rule === "flagged") return t("memory.archived.flagged", { date, by: cause.by ?? "—" });
  const text = cause.rule === "outdated" ? cause.evidence : cause.text;
  return (
    <>
      {t(cause.rule === "outdated" ? "memory.archived.outdated" : "memory.archived.recorded", { date })} <Written text={text} lang={null} />
    </>
  );
}

const sourceLabel = (t: Copy, source: string) => t(`memory.source.${source}` as ProductCopyKey);

const LINK = "rounded-sm text-link hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

/** A key as the reader reads it: bare in this project, with its project's slug in another. */
const keyLabel = (ref: string, project: string | null | undefined, slug: string) => (project && project !== slug ? `${project} ${ref}` : ref);

/** Where a cited source lives (MJ-6): an issue, requirement, workflow or release page, or the commit on the repository host. */
function citeHref(c: MemoryCite): string | null {
  if (c.kind === "commit") return c.url ?? null;
  if (!c.project) return null;
  if (c.kind === "issue") return issueHref(c.project, c.ref);
  if (c.kind === "requirement") return requirementHref(c.project, c.ref);
  if (c.kind === "workflow") return workflowHref(c.project, c.ref);
  return releaseHref(c.project, c.ref);
}

function Cite({ cite, slug }: { cite: MemoryCite; slug: string }) {
  const t = useCopy();
  const label = keyLabel(cite.ref, cite.project, slug);
  if (cite.kind !== "commit" && !cite.project) return <span>{t("memory.citeElsewhere", { ref: cite.ref })}</span>;
  const href = citeHref(cite);
  const mono = cite.kind === "commit" ? "font-mono" : "";
  if (!href) return <span className={mono}>{label}</span>;
  return cite.kind === "commit" ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${LINK} ${mono}`}>
      {label}
    </a>
  ) : (
    <Link href={href} className={`${LINK} ${cite.state === "gone" ? "line-through" : ""}`}>
      {label}
    </Link>
  );
}

/** Core's reasons a memory needs a check that no other line of the row already says. */
function needsCheckText(t: Copy, entry: MemoryEntry, slug: string): string | null {
  const parts = [
    entry.needsCheck.includes("unchecked") ? t("memory.check.unchecked", { days: MEMORY_CHECK_AFTER_DAYS }) : null,
    entry.needsCheck.includes("changed") && entry.changed.length > 0
      ? t("memory.check.changed", { refs: entry.changed.map((c) => keyLabel(c.ref, c.project, slug)).join(", ") })
      : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? t("memory.check.lead", { why: parts.join("; ") }) : null;
}

export function MemoryEntryRow({ entry, slug, timeZone, busy, onVerify, onCorrect, onRetire }: MemoryEntryRowProps) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  const day = (iso: string) => formatDate(iso, lang, timeZone);
  const [mode, setMode] = useState<Mode>("read");
  const [text, setText] = useState(entry.text);
  const [reason, setReason] = useState("");
  const mirror = (MEMORY_MIRROR_SOURCES as readonly string[]).includes(entry.source);
  const gone = entry.archivedAt !== null;
  const canAct = !mirror && !gone;
  const reasonOk = reason.trim().length >= REASON_MIN;
  const needsCheck = needsCheckText(t, entry, slug);
  const close = () => {
    setMode("read");
    setReason("");
    setText(entry.text);
  };

  return (
    <li className="grid gap-1.5 border-b border-line-subtle px-5 py-3 max-md:px-3" data-testid="memory-entry">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-12-5 text-fg" translate="no">
          {entry.sourceRef}
        </span>
        <span className="text-12 text-subtle">{sourceLabel(t, entry.source)}</span>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-12 text-muted" data-testid="memory-meta">
        <span>{t("memory.writtenBy", { name: actorName(t, entry.writtenBy) })}</span>
        <span>{t("memory.updated", { date: day(entry.updatedAt) })}</span>
        <span data-testid="memory-checked">
          {!entry.verifiedAt
            ? t("memory.neverVerified")
            : entry.verifiedBy
              ? t("memory.verifiedBy", { date: day(entry.verifiedAt), name: actorName(t, entry.verifiedBy) })
              : t("memory.verified", { date: day(entry.verifiedAt) })}
        </span>
      </p>
      {needsCheck ? (
        <p className="text-12-5 text-amber-700 dark:text-amber-300" data-testid="memory-needs-check">
          {needsCheck}
        </p>
      ) : null}
      {mode === "correct" ? null : <p className="whitespace-pre-wrap text-13 text-fg">{entry.text}</p>}
      {entry.cites.length > 0 ? (
        <p className="flex flex-wrap gap-x-1.5 text-12 text-subtle" data-testid="memory-cites">
          <span>{t("memory.cites")}</span>
          {entry.cites.map((c, i) => (
            <Fragment key={`${c.kind}:${c.project ?? "-"}:${c.ref}`}>
              {i > 0 ? <span aria-hidden>·</span> : null}
              <span translate="no">
                <Cite cite={c} slug={slug} />
              </span>
            </Fragment>
          ))}
        </p>
      ) : null}
      {entry.staleRefs.length > 0 ? (
        <p className="text-12-5 font-semibold text-danger" data-testid="memory-stale-refs">
          {t("memory.staleRefs", { refs: entry.staleRefs.map((r) => `${keyLabel(r.ref, r.project, slug)} (${staleWhy(t, r)})`).join(", ") })}
        </p>
      ) : null}
      {entry.flagged ? (
        <p className="text-12-5 text-amber-700 dark:text-amber-300" data-testid="memory-flagged">
          {entry.flagged.reason !== null ? (
            <>
              {t("memory.flaggedBecause", { by: entry.flagged.by ?? "—", date: day(entry.flagged.since) })} <Written text={entry.flagged.reason} lang={null} />
              {t("memory.flaggedCheck")}
            </>
          ) : (
            t("memory.flaggedNoReason", { by: entry.flagged.by ?? "—", date: day(entry.flagged.since) })
          )}
        </p>
      ) : null}
      {entry.corrections.length > 0 ? (
        <ul className="grid gap-0.5 text-12 text-muted" data-testid="memory-corrections">
          {entry.corrections.map((c) => (
            <li key={c.at}>{t("memory.corrected", { name: actorName(t, c.by), date: day(c.at), reason: c.reason })}</li>
          ))}
        </ul>
      ) : null}
      {entry.revisions.length > 0 ? (
        <details className="text-12 text-muted" data-testid="memory-revisions">
          <summary className="cursor-pointer select-none">
            {entry.revisionCount > entry.revisions.length ? t("memory.earlierShown", { shown: entry.revisions.length, n: entry.revisionCount }) : t("memory.earlier", { n: entry.revisionCount })}
          </summary>
          <ol className="mt-1 grid gap-2 border-l border-line-subtle pl-3">
            {entry.revisions.map((r) => (
              <li key={r.replacedAt} className="grid gap-0.5" data-testid="memory-revision">
                <span>{t("memory.replaced", { date: day(r.replacedAt), name: actorName(t, r.writtenBy) })}</span>
                <p className="whitespace-pre-wrap text-12-5 text-fg">{r.text}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {gone ? (
        <p className="text-12-5 text-muted" data-testid="memory-retired">
          {entry.retired
            ? t("memory.retiredBy", { name: actorName(t, entry.retired.by), date: day(entry.retired.at), reason: entry.retired.reason })
            : archivedLine(t, entry.archivedBy, day(entry.archivedAt as string))}
        </p>
      ) : null}
      {mirror ? (
        <p className="text-12 text-subtle" data-testid="memory-mirror">
          {t("memory.mirror", { source: sourceLabel(t, entry.source) })}
        </p>
      ) : null}

      {canAct && mode === "read" ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onVerify(entry.id)}>
            {t("memory.stillTrue")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("untrue")}>
            {t("memory.notTrue")}
          </Button>
        </div>
      ) : null}

      {canAct && mode === "untrue" ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setMode("correct")}>
            {t("memory.correct")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("retire")}>
            {t("memory.retire")}
          </Button>
          <Button size="sm" variant="ghost" onClick={close}>
            {t("memory.cancel")}
          </Button>
        </div>
      ) : null}

      {canAct && (mode === "correct" || mode === "retire") ? (
        <form
          className="grid max-w-[760px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reasonOk || busy) return;
            if (mode === "correct") onCorrect(entry.id, { text: text.trim(), reason: reason.trim() });
            else onRetire(entry.id, { reason: reason.trim() });
            close();
          }}
        >
          {mode === "correct" ? (
            <Field label={t("memory.correctedText")}>
              <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          ) : null}
          <Field label={t("memory.why")} hint={t("memory.whyHint")}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={mode === "retire" ? "danger" : "primary"} disabled={!reasonOk || (mode === "correct" && !text.trim())} loading={busy}>
              {mode === "correct" ? t("memory.saveCorrection") : t("memory.retireConfirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              {t("memory.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}
