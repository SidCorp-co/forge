"use client";

import { Badge } from "@/design";
import type { LiveReach, LiveReachCommit } from "../types";

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** What was compared and when, as text rather than only a hover, so a keyboard reader gets it too. */
function Compared({ reach }: { reach: Extract<LiveReach, { baseSha: string }> }) {
  return (
    <span className="fg-caption font-mono">
      {reach.baseBranch} {short(reach.baseSha)} vs {reach.liveBranch} {short(reach.liveSha)} · read{" "}
      {reach.measuredAt.slice(0, 16).replace("T", " ")}
    </span>
  );
}

/**
 * Waiting commits core could give to no issue. "Nothing waiting" is only as good as that
 * attribution, so a reader is told how many commits it could not attribute and can open the list;
 * a native summary opens by Enter, Space or pointer.
 */
function Unowned({ commits }: { commits: LiveReachCommit[] }) {
  if (commits.length === 0) return null;
  const n = commits.length;
  return (
    <details className="flex flex-col items-end gap-1">
      <summary className="fg-caption cursor-pointer">
        {n} waiting commit{n === 1 ? "" : "s"} belong{n === 1 ? "s" : ""} to no issue
      </summary>
      {commits.map((c) => (
        <span key={c.sha} className="fg-caption font-mono block" title={c.subject}>
          {short(c.sha)} {c.subject}
        </span>
      ))}
    </details>
  );
}

/**
 * Whether a merged issue's work is on the project's live branch, as core read it. Absence of a
 * waiting commit is shown as exactly that, never as "live": core cannot prove the second.
 */
export function LiveReachValue({ reach }: { reach: LiveReach }) {
  if (reach.state === "not_on_live") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span title={`Waiting on ${reach.baseBranch} at ${short(reach.baseSha)}, not on ${reach.liveBranch} at ${short(reach.liveSha)}, read ${reach.measuredAt}`}>
          <Badge tone="red">Not on production</Badge>
        </span>
        {reach.evidence.map((e) => (
          <span key={e.sha} className="fg-caption font-mono" title={e.subject}>
            {short(e.sha)} {e.subject}
          </span>
        ))}
        <Compared reach={reach} />
      </div>
    );
  }
  if (reach.state === "none_waiting") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span
          className="fg-caption"
          title={`${reach.baseBranch} at ${short(reach.baseSha)} against ${reach.liveBranch} at ${short(reach.liveSha)}, read ${reach.measuredAt}`}
        >
          Nothing waiting for {reach.liveBranch}
        </span>
        <Unowned commits={reach.unowned} />
        <Compared reach={reach} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Badge tone="amber">Not measured</Badge>
      <span className="fg-caption">{reach.reason}</span>
    </div>
  );
}
