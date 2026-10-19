"use client";

// ISS-1133 — what each run of the issue did, as one view: the run, the sessions that ran it, and
// every attempt its journal recorded with the handoff that attempt left. Flat: hairlines between
// runs and between attempts, hierarchy by type and whitespace, no card.

import { jobKindLabel } from "@/features/overview/job-kinds";
import { useState } from "react";
import { EmptyPanelLine, Icon, STOPPED_WORD } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatDurationMs, formatDurationSec, formatRelativeTime, formatUsd } from "@/lib/utils/format";
import {
  type AttemptState,
  type AttemptView,
  FRESH_REASON_COPY,
  type RunView,
} from "../derive";

const TITLE = "Runs";

/** An empty or unread line drawn flush: a hairline above in place of the card's border. */
const FLAT_PANEL_LINE = "rounded-none border-0 border-t border-line-subtle bg-transparent px-0 shadow-none";

const RUN_STATUS: Record<RunView["status"], { label: string; dot: string }> = {
  running: { label: "Running", dot: "var(--pipeline-active)" },
  paused: { label: "Paused", dot: "var(--amber-500)" },
  completed: { label: "Completed", dot: "var(--green-500)" },
  failed: { label: "Failed", dot: "var(--red-500)" },
  cancelled: { label: STOPPED_WORD, dot: "var(--border-strong)" },
};

const ATTEMPT_STATE: Record<AttemptState, { label: string; dot: string }> = {
  done: { label: "Done", dot: "var(--green-500)" },
  running: { label: "Running", dot: "var(--pipeline-active)" },
  failed: { label: "Failed", dot: "var(--red-500)" },
  abandoned: { label: "Abandoned", dot: "var(--border-strong)" },
  "left-open": { label: "Left open", dot: "var(--amber-500)" },
};

interface RunJournalSectionProps {
  runs: RunView[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

export function RunJournalSection({ runs, loading, error, onRetry }: RunJournalSectionProps) {
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string> | null>(null);

  if (loading) return <EmptyPanelLine title={TITLE} status="Loading…" className={FLAT_PANEL_LINE} />;
  if (error) {
    return (
      <EmptyPanelLine
        title={TITLE}
        status="Couldn't load"
        detail={formatApiError(error)}
        className={FLAT_PANEL_LINE}
        action={
          <button type="button" onClick={onRetry} className="fg-caption text-muted hover:text-fg">
            Retry
          </button>
        }
      />
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyPanelLine
        title={TITLE}
        status="None yet"
        detail="Each run appears here with the phases it recorded."
        className={FLAT_PANEL_LINE}
      />
    );
  }

  // The newest run opens by itself; once a person toggles one, what they chose stands.
  const open = openRuns ?? new Set(runs[0] ? [runs[0].runId] : []);
  const toggle = (runId: string) => {
    const next = new Set(open);
    if (next.has(runId)) next.delete(runId);
    else next.add(runId);
    setOpenRuns(next);
  };

  return (
    <section aria-label={TITLE} className="border-t border-line-subtle pt-4">
      <h2 className="fg-label mb-1">{TITLE}</h2>
      <ol>
        {runs.map((run) => (
          <RunBlock
            key={run.runId}
            run={run}
            open={open.has(run.runId)}
            onToggle={() => toggle(run.runId)}
          />
        ))}
      </ol>
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-1.5 flex-none rounded-full" style={{ background: color }} />;
}

function runSpan(run: RunView): string | null {
  if (!run.finishedAt) return null;
  return formatDurationMs(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}

function RunBlock({ run, open, onToggle }: { run: RunView; open: boolean; onToggle: () => void }) {
  const status = RUN_STATUS[run.status];
  const span = runSpan(run);
  // Each time says which it is: a finished run when it ended and how long it ran, one still going
  // when it started (ISS-1228).
  const facts = [
    run.finishedAt ? `Ended ${formatRelativeTime(run.finishedAt)}` : `Started ${formatRelativeTime(run.startedAt)}`,
    span ? `ran ${span}` : null,
    run.costUsd != null ? formatUsd(run.costUsd) : null,
  ].filter(Boolean);
  const phases = run.attempts.length;
  const count = phases === 0 ? "no phase recorded" : `${phases} ${phases === 1 ? "phase" : "phases"}`;
  const group = run.alongside.length > 0 ? `with ${run.alongside.join(", ")}` : null;

  return (
    <li className="border-t border-line-subtle first:border-t-0" data-run={run.runId}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={[`Run ${run.ordinal}`, status.label, group, count, ...facts].filter(Boolean).join(", ")}
        className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 py-2.5 text-left"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="flex-none text-muted" />
        <span className="fg-body-sm font-semibold">Run {run.ordinal}</span>
        <span className="fg-caption inline-flex items-center gap-1.5 text-muted">
          <Dot color={status.dot} />
          {status.label}
        </span>
        {group && <span className="fg-caption text-muted">{group}</span>}
        {!open && (
          <span className="fg-caption text-muted">{count}</span>
        )}
        <span className="fg-caption ml-auto whitespace-nowrap tabular-nums text-muted">
          {facts.join(" · ")}
        </span>
      </button>

      {open && (
        <div className="pb-3 pl-6">
          {run.sessions.length > 0 && <SessionsLine sessions={run.sessions} />}
          {phases === 0 ? (
            <p className="fg-body-sm py-1 text-muted">This run recorded no phase.</p>
          ) : (
            <ol aria-label={`Run ${run.ordinal} phases`}>
              {run.attempts.map((attempt) => (
                <AttemptRow key={attempt.key} attempt={attempt} />
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

function SessionsLine({ sessions }: { sessions: RunView["sessions"] }) {
  return (
    <p className="fg-caption mb-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted">
      <span className="uppercase tracking-wide text-subtle">Sessions</span>
      {sessions.map((s) => {
        const where = s.deviceName ?? s.deviceShort;
        const continuity =
          s.continuity === "resumed" ? "resumed" : s.continuity === "fresh" ? "fresh session" : null;
        return (
          <span
            key={s.id}
            title={s.continuity === "fresh" && s.freshReason ? FRESH_REASON_COPY[s.freshReason] : undefined}
          >
            <span>{s.jobType ? jobKindLabel(s.jobType) : "session"}</span>
            {continuity ? ` ${continuity}` : ""}
            {where ? ` on ${where}` : ""}
          </span>
        );
      })}
    </p>
  );
}

const SKIP_KEYS = new Set(["step", "schema_version", "schemaVersion"]);
const ARRAY_TEXT_KEYS = ["path", "file", "title", "name", "test", "what", "step"];

function listText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    const key = ARRAY_TEXT_KEYS.find((k) => typeof item[k] === "string");
    if (key) return String(item[key]);
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function handoffFields(handoff: Record<string, unknown>) {
  const paragraphs: { key: string; text: string }[] = [];
  const lists: { key: string; items: string[] }[] = [];
  for (const [key, value] of Object.entries(handoff)) {
    if (SKIP_KEYS.has(key)) continue;
    if (typeof value === "string" && value.trim()) paragraphs.push({ key, text: value.trim() });
    else if (Array.isArray(value)) {
      const items = value.map(listText).filter((t) => t.trim());
      if (items.length) lists.push({ key, items });
    }
  }
  return { paragraphs, lists };
}

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

function AttemptRow({ attempt }: { attempt: AttemptView }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const state = ATTEMPT_STATE[attempt.state];
  const hasDetail = !!attempt.handoff || !!attempt.artifact;
  const times = [
    `started ${clock(attempt.startedAt)}`,
    attempt.endedAt ? `ended ${clock(attempt.endedAt)}` : null,
    attempt.handoffAt ? `handoff ${clock(attempt.handoffAt)}` : null,
  ].filter(Boolean);

  const row = (
    <>
      <span className="min-w-0 truncate font-mono text-12-5">
        {attempt.phase}
        {attempt.numbered && <span className="text-muted"> #{attempt.attempt}</span>}
      </span>
      <span className="fg-caption inline-flex items-center gap-1.5 whitespace-nowrap text-muted">
        <Dot color={state.dot} />
        {state.label}
      </span>
      <span className="fg-caption order-last col-span-3 min-w-0 truncate text-muted sm:order-none sm:col-span-1">
        {attempt.summary ?? ""}
      </span>
      <span className="fg-caption whitespace-nowrap text-right tabular-nums text-muted">
        {attempt.durationSeconds != null ? formatDurationSec(attempt.durationSeconds) : "—"}
      </span>
    </>
  );
  const grid =
    "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5 py-2 text-left sm:grid-cols-[10rem_6.5rem_minmax(0,1fr)_4.5rem]";

  return (
    <li className="border-t border-line-subtle first:border-t-0">
      {hasDetail ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${grid} hover:text-fg`}>
          {row}
        </button>
      ) : (
        <div className={grid}>{row}</div>
      )}
      {open && (
        <div className="forge-fade space-y-3 pb-3 pt-1">
          <p className="fg-caption text-muted">{times.join(" · ")}</p>
          {attempt.artifact && <ArtifactLine artifact={attempt.artifact} />}
          {attempt.handoff && <HandoffBody handoff={attempt.handoff} />}
          {attempt.handoff && (
            <div>
              <button
                type="button"
                onClick={() => setRaw((v) => !v)}
                aria-expanded={raw}
                className="fg-caption inline-flex items-center gap-1 text-muted transition-colors hover:text-fg"
              >
                <Icon name={raw ? "chevronDown" : "chevronRight"} size={12} />
                Raw handoff
              </button>
              {raw && (
                <pre className="mt-2 max-h-72 overflow-auto bg-app/60 p-2 text-11 leading-snug">
                  {JSON.stringify(attempt.handoff, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ArtifactLine({ artifact }: { artifact: Record<string, unknown> }) {
  if (artifact.kind === "commit" && typeof artifact.sha === "string") {
    return (
      <p className="fg-body-sm">
        <span className="fg-caption uppercase tracking-wide text-muted">commit </span>
        <span className="font-mono">{artifact.sha.slice(0, 12)}</span>
        {typeof artifact.message === "string" ? ` ${artifact.message}` : ""}
      </p>
    );
  }
  if (artifact.kind === "note" && typeof artifact.text === "string") {
    return <p className="fg-body-sm whitespace-pre-wrap">{artifact.text}</p>;
  }
  return null;
}

function HandoffBody({ handoff }: { handoff: Record<string, unknown> }) {
  const { paragraphs, lists } = handoffFields(handoff);
  return (
    <>
      {paragraphs.map((p) => (
        <div key={p.key}>
          <p className="fg-caption uppercase tracking-wide text-muted">{p.key}</p>
          <p className="fg-body-sm whitespace-pre-wrap break-words">{p.text}</p>
        </div>
      ))}
      {lists.map((l) => (
        <div key={l.key}>
          <p className="fg-caption uppercase tracking-wide text-muted">{l.key}</p>
          <ul className="fg-body-sm list-disc space-y-0.5 pl-5">
            {l.items.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a handoff list may repeat an entry, and its place is all that tells two apart
              <li key={`${l.key}-${i}`} className="break-words">
                {text}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
