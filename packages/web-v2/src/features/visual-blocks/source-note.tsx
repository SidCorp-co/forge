"use client";

import type { ExecutionFacts } from "@forge/contracts/report-executions";
import type { BlockSource } from "@forge/contracts/visual-blocks";
import { useState } from "react";
import { useTimeFormat } from "@/lib/i18n/interface-language";
import { useBlockInstants } from "./instants";
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

/** A setting's name as a person reads it: "windowDays" and "window_days" both read "window days". */
const settingName = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();

/** A setting's value in words: a list joined, a nested value as JSON, an instant read in the viewer's timezone. */
function settingValue(value: unknown, read: (iso: string) => string): string {
  if (typeof value === "string") return read(value);
  if (Array.isArray(value)) return value.map((v) => settingValue(v, read)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Where a block's figures came from, in one short line: the query and when it was read. The run id
 * and the full read time sit behind the line's disclosure. A frame from an execution is labelled
 * computed. A block of a run whose query and read time are unknown never reaches here:
 * `VisualBlockView` refuses it by name.
 */
export function SourceNote({
  source,
  facts,
  execution,
}: {
  source: BlockSource | undefined;
  facts: SourceFacts | undefined;
  execution?: ExecutionFacts | undefined;
}) {
  if (source === undefined) return null;
  if ("executionId" in source) return <ExecutionSource executionId={source.executionId} execution={execution} />;
  if (!facts) return null;
  return <RunSource runId={source.runId} facts={facts} />;
}

function RunSource({ runId, facts }: { runId: string; facts: SourceFacts }) {
  const [open, setOpen] = useState(false);
  const read = useReadAt(facts.asOf);
  const instants = useBlockInstants();
  const settings = Object.entries(facts.params ?? {}).filter(([, v]) => v !== undefined && v !== null);
  const settingsText =
    facts.params === undefined
      ? null
      : settings.length === 0
        ? "Settings: none set, the report's defaults"
        : `Settings: ${settings.map(([k, v]) => `${settingName(k)} ${settingValue(v, instants.instant)}`).join(" · ")}`;
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
      {open && settingsText && (
        <p className="m-0 mt-0.5" data-testid="visual-block-settings">
          {settingsText}
        </p>
      )}
    </div>
  );
}

/** A computed block's source: the execution, and behind the line who asked it and each read it made of Forge, a refused one named. */
function ExecutionSource({ executionId, execution }: { executionId: string; execution: ExecutionFacts | undefined }) {
  const [open, setOpen] = useState(false);
  const line = (
    <>
      Computed by execution <span className="font-mono">{executionId}</span>
    </>
  );
  if (!execution?.askedBy || !execution.reads) {
    return (
      <p className={LINE} data-testid="visual-block-source">
        {line}
      </p>
    );
  }
  const { askedBy, reads, script, result } = execution;
  return (
    <div className={LINE} data-testid="visual-block-source">
      <button
        type="button"
        className="text-left hover:text-muted focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="visual-block-source-toggle"
      >
        {line}
      </button>
      {open && (
        <div className="mt-0.5" data-testid="visual-block-source-detail">
          <p className="m-0">Ran as {askedBy.name ?? askedBy.id}</p>
          {script !== undefined && (
            <pre className="m-0 mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap font-mono" data-testid="visual-block-script">
              {script}
            </pre>
          )}
          {result && (
            <p className="m-0 mt-0.5" data-testid="visual-block-result">
              {result.error
                ? `Failed: ${result.error.name}: ${result.error.message}`
                : result.stopped
                  ? `Stopped at the ${result.stopped} limit`
                  : `Finished with exit ${result.exit}`}{" "}
              in {result.durationMs} ms
              {result.stdout.trim() ? ` · printed: ${result.stdout.trim()}` : ""}
            </p>
          )}
          {reads.length === 0 ? (
            <p className="m-0">Read nothing from Forge</p>
          ) : (
            <ul className="m-0 list-none p-0 font-mono" data-testid="visual-block-reads">
              {reads.map((r, i) => (
                // the same path can be read twice in one run, so the position is part of what a read is
                // biome-ignore lint/suspicious/noArrayIndexKey: a run's reads are fixed once recorded
                <li key={i}>
                  {r.method} {r.path} {r.refused ? `refused: ${r.refused}` : r.status}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
