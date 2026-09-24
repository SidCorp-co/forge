"use client";

import { Badge } from "@/design";
import type { LiveReach } from "../types";

function short(sha: string): string {
  return sha.slice(0, 8);
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
      </div>
    );
  }
  if (reach.state === "none_waiting") {
    return (
      <span
        className="fg-caption"
        title={`${reach.baseBranch} at ${short(reach.baseSha)} against ${reach.liveBranch} at ${short(reach.liveSha)}, read ${reach.measuredAt}`}
      >
        Nothing waiting for {reach.liveBranch}
      </span>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Badge tone="amber">Not measured</Badge>
      <span className="fg-caption">{reach.reason}</span>
    </div>
  );
}
