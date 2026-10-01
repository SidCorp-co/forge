"use client";

import { Badge, Kicker } from "@/design";
import { cn } from "@/lib/utils/cn";
import { durationOf, msOf, stampOf } from "../format";
import type { ReleaseAttempt, ReleaseBoundsReading } from "../types";
import { AttemptBacking } from "./attempt-backing";

function verdictPill(a: ReleaseAttempt) {
  if (a.settledAt === null) return <Badge tone="amber">running · {durationOf(a.startedAt, null)}</Badge>;
  const took = durationOf(a.startedAt, a.settledAt);
  if (a.verdict === "ok") return <Badge tone="green">{took}</Badge>;
  if (a.verdict === "failed") return <Badge tone="red">failed · {took}</Badge>;
  return <Badge tone="amber">unverified · {took}</Badge>;
}

function LogTail({ attempt }: { attempt: ReleaseAttempt }) {
  if (!attempt.logTail) {
    return (
      <p className="rounded-md bg-sunken px-3 py-2 text-12 text-subtle" data-testid="log-empty">
        The act reported no log.
      </p>
    );
  }
  return (
    <pre
      className="max-h-[230px] overflow-auto whitespace-pre-wrap rounded-lg px-3.5 py-3 font-mono text-11 leading-relaxed"
      style={{ background: "#14161b", color: "#c9cdd4" }}
      data-testid="log-tail"
    >
      {attempt.logTail}
    </pre>
  );
}

function Bounds({ attempt, bounds }: { attempt: ReleaseAttempt; bounds: ReleaseBoundsReading }) {
  const cut = attempt.logTailTruncated
    ? attempt.logTailReadAt
      ? `truncated · read past the cut by ${attempt.logTailReadBy ?? "someone"}`
      : "truncated · nobody has read past the cut"
    : "whole log";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="log-bounds">
      <span className={cn("text-12", attempt.logTailTruncated && !attempt.logTailReadAt ? "text-amber" : "text-subtle")}>
        {cut}
      </span>
      {bounds.bounds.map((b) => (
        <span key={b.name} title={b.why}>
          <Badge tone={b.crossed ? "red" : "neutral"}>
            {b.name} {msOf(b.measuredMs)} / {msOf(b.thresholdMs)}
          </Badge>
        </span>
      ))}
    </div>
  );
}

export interface DeploymentRowsProps {
  attempts: ReleaseAttempt[];
  bounds: ReleaseBoundsReading;
  environment: string | null;
  open: string | null;
  onToggle: (id: string) => void;
}

export function DeploymentRows({ attempts, bounds, environment, open, onToggle }: DeploymentRowsProps) {
  return (
    <section className="grid gap-1" data-testid="deployments">
      <Kicker>Deployments</Kicker>
      {attempts.length === 0 ? (
        <p className="text-13 text-subtle">No promote, deploy, verify or repair has been recorded on this release yet.</p>
      ) : (
        [...attempts].reverse().map((a) => (
          <div key={a.id}>
            <button
              type="button"
              onClick={() => onToggle(a.id)}
              aria-expanded={open === a.id}
              className={cn(
                "-mx-2 grid w-[calc(100%+16px)] grid-cols-[96px_84px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-13 hover:bg-sunken",
                open === a.id && "bg-sunken",
              )}
              data-testid="deployment-row"
            >
              <span className="text-12 text-subtle">{stampOf(a.startedAt)}</span>
              <span>{environment ?? "—"}</span>
              <span className="truncate">
                {a.stage} <span className="font-mono text-12 text-subtle">{a.providerRef ?? a.idempotencyKey}</span>
              </span>
              {verdictPill(a)}
            </button>
            {open === a.id ? (
              <div className="grid gap-2 py-2" data-testid="deployment-open">
                <LogTail attempt={a} />
                <Bounds attempt={a} bounds={bounds} />
                {a.verdictReason ? <p className="text-12 text-muted">Forge&rsquo;s reading: {a.verdictReason}</p> : null}
                {a.account ? <p className="whitespace-pre-wrap text-12 text-muted">Account: {a.account}</p> : null}
                <AttemptBacking attempt={a} />
              </div>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
