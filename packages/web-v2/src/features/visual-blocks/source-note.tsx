"use client";

import type { BlockSource } from "@forge/contracts/visual-blocks";
import { useState } from "react";
import { useTimeFormat } from "@/lib/i18n/interface-language";
import type { SourceFacts } from "./context";

/**
 * The read time as the thread says a turn's time: the clock alone for a read today, the date and
 * clock for an older one, the full date and time on hover.
 */
function useReadAt(iso: string, now: Date = new Date()): { label: string; full: string } {
  const time = useTimeFormat();
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { label: iso, full: iso };
  const today = time.date(at) === time.date(now);
  return { label: today ? time.clock(at) : time.dateTime(at), full: time.dateTime(at) };
}

const LINE = "mt-1 text-[11px] text-subtle";

/**
 * Where a block's figures came from, in one short line: the query and when it was read. The run id
 * and the full read time sit behind the line's disclosure. A frame from an execution is labelled
 * computed. A block of a run whose query and read time are unknown never reaches here:
 * `VisualBlockView` refuses it by name.
 */
export function SourceNote({ source, facts }: { source: BlockSource | undefined; facts: SourceFacts | undefined }) {
  if (source === undefined) return null;
  if ("executionId" in source) {
    return (
      <p className={LINE} data-testid="visual-block-source">
        Computed by execution <span className="font-mono">{source.executionId}</span>
      </p>
    );
  }
  if (!facts) return null;
  return <RunSource runId={source.runId} facts={facts} />;
}

function RunSource({ runId, facts }: { runId: string; facts: SourceFacts }) {
  const [open, setOpen] = useState(false);
  const read = useReadAt(facts.asOf);
  return (
    <div className={LINE} data-testid="visual-block-source">
      <button
        type="button"
        className="text-left hover:text-muted focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="visual-block-source-toggle"
      >
        <span data-testid="visual-block-query">{facts.queryId}</span>
        {" · read "}
        <time dateTime={facts.asOf} title={read.full}>
          {read.label}
        </time>
      </button>
      {open && (
        <p className="m-0 mt-0.5 font-mono" data-testid="visual-block-source-detail">
          Report run {runId} · read {read.full}
        </p>
      )}
    </div>
  );
}
