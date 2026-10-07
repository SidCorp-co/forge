"use client";

import { Badge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { LiveReach, LiveReachCommit } from "../types";

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** What was compared and when, as text rather than only a hover, so a keyboard reader gets it too. */
function Compared({ reach }: { reach: Extract<LiveReach, { baseSha: string }> }) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <span className="fg-caption font-mono">
      {t("issues.reach.compared", { base: `${reach.baseBranch} ${short(reach.baseSha)}`, live: `${reach.deploysFrom} ${short(reach.liveSha)}`, at: time.dateTime(reach.measuredAt) })}
    </span>
  );
}

/**
 * Waiting commits core could give to no issue. "Nothing waiting" is only as good as that
 * attribution, so a reader is told how many commits it could not attribute and can open the list;
 * a native summary opens by Enter, Space or pointer.
 */
function Unowned({ commits }: { commits: LiveReachCommit[] }) {
  const t = useCopy();
  if (commits.length === 0) return null;
  const n = commits.length;
  return (
    <details className="flex flex-col items-end gap-1">
      <summary className="fg-caption cursor-pointer">
        {n === 1 ? t("issues.reach.unownedOne") : t("issues.reach.unownedMany", { n })}
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
  const t = useCopy();
  if (reach.state === "not_on_live") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span title={t("issues.reach.notOnLiveHint", { base: reach.baseBranch, baseSha: short(reach.baseSha), live: reach.deploysFrom, liveSha: short(reach.liveSha), at: reach.measuredAt })}>
          <Badge tone="red">{t("issues.reach.notOnLive")}</Badge>
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
          title={t("issues.reach.noneWaitingHint", { base: reach.baseBranch, baseSha: short(reach.baseSha), live: reach.deploysFrom, liveSha: short(reach.liveSha), at: reach.measuredAt })}
        >
          {t("issues.reach.noneWaiting", { live: reach.deploysFrom })}
        </span>
        <Unowned commits={reach.unowned} />
        <Compared reach={reach} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Badge tone="amber">{t("issues.reach.notMeasured")}</Badge>
      <span className="fg-caption">{reach.reason}</span>
    </div>
  );
}
