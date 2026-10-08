"use client";

// One memory on the Memory page (MJ-1, MJ-3): what it says, who wrote it and when, whether anyone
// checked it, which records it names that no longer exist, a release's "may be outdated" flag read
// as the guess it is, and every correction or retirement with its reason. Correct and Retire each
// take a reason before they send; a mirror of an issue, comment or job offers neither.

import { MEMORY_MIRROR_SOURCES, type MemoryActor, type MemoryEntry, type MemoryStaleRef } from "@forge/contracts/memory";
import { useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { formatDate } from "@/lib/i18n/format";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";

/** A reason short enough to be a word is not one; core holds the same floor. */
const REASON_MIN = 3;

type Mode = "read" | "correct" | "retire";

export interface MemoryEntryRowProps {
  entry: MemoryEntry;
  slug: string;
  timeZone?: string;
  busy: boolean;
  onCorrect: (id: string, body: { text: string; reason: string }) => void;
  onRetire: (id: string, body: { reason: string }) => void;
}

function actorName(t: Copy, a: MemoryActor | null): string {
  if (!a) return t("memory.writerUnknown");
  return a.agent ? t("memory.agentName", { name: a.name }) : a.name;
}

function staleWhy(t: Copy, r: MemoryStaleRef): string {
  if (r.why === "missing") return t(r.kind === "issue" ? "memory.why.missing.issue" : "memory.why.missing.requirement");
  return t(`memory.why.${r.why}` as ProductCopyKey);
}

const sourceLabel = (t: Copy, source: string) => t(`memory.source.${source}` as ProductCopyKey);

export function MemoryEntryRow({ entry, timeZone, busy, onCorrect, onRetire }: MemoryEntryRowProps) {
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
        <span>{entry.verifiedAt ? t("memory.verified", { date: day(entry.verifiedAt) }) : t("memory.neverVerified")}</span>
      </p>
      {mode === "correct" ? null : <p className="whitespace-pre-wrap text-13 text-fg">{entry.text}</p>}
      {entry.cites.length > 0 ? (
        <p className="text-12 text-subtle" translate="no">
          {t("memory.cites", { refs: entry.cites.join(", ") })}
        </p>
      ) : null}
      {entry.staleRefs.length > 0 ? (
        <p className="text-12-5 font-semibold text-danger" data-testid="memory-stale-refs">
          {t("memory.staleRefs", { refs: entry.staleRefs.map((r) => `${r.ref} (${staleWhy(t, r)})`).join(", ") })}
        </p>
      ) : null}
      {entry.flagged ? (
        <p className="text-12-5 text-amber-700 dark:text-amber-300" data-testid="memory-flagged">
          {t("memory.flagged", { by: entry.flagged.by ?? "—", date: day(entry.flagged.since) })}
        </p>
      ) : null}
      {entry.corrections.length > 0 ? (
        <ul className="grid gap-0.5 text-12 text-muted" data-testid="memory-corrections">
          {entry.corrections.map((c) => (
            <li key={c.at}>{t("memory.corrected", { name: actorName(t, c.by), date: day(c.at), reason: c.reason })}</li>
          ))}
        </ul>
      ) : null}
      {gone ? (
        <p className="text-12-5 text-muted" data-testid="memory-retired">
          {entry.retired
            ? t("memory.retiredBy", { name: actorName(t, entry.retired.by), date: day(entry.retired.at), reason: entry.retired.reason })
            : entry.archivedBy
              ? t("memory.archivedBy", { date: day(entry.archivedAt as string), why: entry.archivedBy })
              : t("memory.archivedUnknown", { date: day(entry.archivedAt as string) })}
        </p>
      ) : null}
      {mirror ? (
        <p className="text-12 text-subtle" data-testid="memory-mirror">
          {t("memory.mirror", { source: sourceLabel(t, entry.source) })}
        </p>
      ) : null}

      {canAct && mode === "read" ? (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setMode("correct")}>
            {t("memory.correct")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("retire")}>
            {t("memory.retire")}
          </Button>
        </div>
      ) : null}

      {canAct && mode !== "read" ? (
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
