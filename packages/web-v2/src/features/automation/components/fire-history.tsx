"use client";

// cm:why one fire history for every screen that lists a schedule's fires (ISS-114): the schedules row
// and the improvement loop's run log read the fires, their why and what each produced from the
// automation read model, so neither keeps its own reading of a run's result

import Link from "next/link";
import { EnumBadge, Spinner, StatusBadge, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useScheduleDetail } from "../hooks";
import type { FireProduced, FireProposal, FireStanding } from "../types";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const PRODUCED: Array<[keyof Omit<FireProduced, "newReports">, string]> = [
  ["reports", "report"],
  ["proposals", "proposal"],
  ["issues", "issue"],
  ["runs", "run"],
  ["notifications", "notification"],
];

export function producedLine(p: FireProduced): string {
  const parts = PRODUCED.filter(([k]) => p[k] > 0).map(([k, noun]) => `${p[k]} ${noun}${p[k] === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing produced";
}

function FireRow({
  fire,
  proposals,
  slug,
}: {
  fire: FireStanding & { output: string | null };
  proposals: FireProposal[];
  slug: string | undefined;
}) {
  const why = fire.refusal ?? fire.error ?? fire.reason;
  const head = (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <EnumBadge family="trigger" value={fire.trigger} />
      <StatusBadge family="scheduleRun" value={fire.status} />
      <span className="fg-caption text-subtle">{fmtTime(fire.startedAt)}</span>
      <span className="fg-caption font-mono text-subtle">{fmtDuration(fire.durationSeconds)}</span>
      <span className="fg-caption text-muted">{producedLine(fire.produced)}</span>
      {why && (
        <Tooltip label={fire.error ?? why}>
          <span className="fg-caption text-danger underline decoration-dotted">why?</span>
        </Tooltip>
      )}
      {fire.sessionId && slug && <span className="fg-caption text-accent">View session →</span>}
    </div>
  );
  return (
    <div data-testid="fire-history-row">
      {fire.sessionId && slug ? (
        <Link
          href={`/projects/${slug}/agents/${fire.sessionId}`}
          className="block rounded-md px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {head}
        </Link>
      ) : (
        head
      )}
      {proposals.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1.5 pl-1">
          {proposals.map((a) => (
            <Tooltip key={`${a.skill}:${a.summary}`} label={a.summary}>
              <span className="inline-flex items-center gap-1">
                <StatusBadge family="stewardAction" value={a.kind} />
                <span className="fg-caption max-w-[160px] truncate text-muted">{a.skill}</span>
              </span>
            </Tooltip>
          ))}
        </div>
      )}
      {!fire.sessionId && fire.output && (
        <pre className="fg-caption mb-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words bg-surface-subtle p-2 text-muted">
          {fire.output}
        </pre>
      )}
    </div>
  );
}

export function FireHistory({
  projectId,
  scheduleId,
  slug,
}: {
  projectId: string;
  scheduleId: string;
  slug: string | undefined;
}) {
  const detailQ = useScheduleDetail(projectId, scheduleId, true);
  const fires = detailQ.data?.fires ?? [];
  const proposals = detailQ.data?.proposals ?? [];
  return (
    <div>
      <p className="fg-label mb-1 text-subtle">Recent fires</p>
      {detailQ.isLoading && (
        <span className="inline-flex items-center gap-2 fg-caption text-subtle">
          <Spinner size={14} /> Loading fires…
        </span>
      )}
      {detailQ.isError && (
        <span className="fg-caption text-danger">Couldn&apos;t load its fires — {formatApiError(detailQ.error)}</span>
      )}
      {!detailQ.isLoading && !detailQ.isError && fires.length === 0 && (
        <span className="fg-caption text-subtle">No fires yet.</span>
      )}
      {fires.length > 0 && (
        <div className="divide-y divide-line-subtle">
          {fires.map((f) => (
            <FireRow key={f.id} fire={f} proposals={proposals.filter((p) => p.fireId === f.id)} slug={slug} />
          ))}
        </div>
      )}
    </div>
  );
}
