"use client";

import Link from "next/link";
import { MonoTag } from "@/design";
import { holderLine, orderHolds } from "../derive";
import type { HeldIssue, Holder } from "../types";

const OUTER = "sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,3.8fr)] sm:gap-4";
const INNER = "sm:grid sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_minmax(0,0.7fr)] sm:gap-4";

/** One holder per kind and identity on an issue: a session, a claim's holder, a park's status. */
function holderKey(holder: Holder): string {
  if (holder.by === "session") return `session-${holder.sessionId}`;
  if (holder.by === "claim") return `claim-${holder.holder}`;
  return `person-${holder.status}`;
}

function Label({ children }: { children: string }) {
  return <span className="fg-caption mr-1.5 sm:hidden">{children}</span>;
}

function HoldRow({ hold, slug, now }: { hold: HeldIssue; slug: string; now: number }) {
  return (
    <li className={`flex flex-col gap-2 py-3 ${OUTER}`} data-issue-id={hold.issueId}>
      <Link
        href={`/projects/${slug}/issues/${hold.issueId}`}
        className="flex min-w-0 items-baseline gap-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <MonoTag>{hold.displayId}</MonoTag>
        <span className="fg-label min-w-0 truncate">{hold.title}</span>
      </Link>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {hold.holders.map((holder) => {
          const line = holderLine(holder, now);
          return (
            <li key={holderKey(holder)} className={`fg-body-sm flex min-w-0 flex-col gap-0.5 ${INNER}`}>
              <span className="min-w-0 text-fg">
                <Label>Held by</Label>
                {line.who}
              </span>
              <span className="min-w-0 break-words">
                <Label>Why</Label>
                {line.why}
              </span>
              <span>
                <Label>Since</Label>
                {line.since}
              </span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function HoldsList({ holds, slug, now }: { holds: HeldIssue[]; slug: string; now: number }) {
  if (holds.length === 0) {
    return <p className="fg-body-sm border-y border-line py-4">Nothing on this project is held.</p>;
  }
  return (
    <div>
      <div className={`fg-caption hidden border-b border-line pb-2 ${OUTER}`} aria-hidden="true">
        <span>Issue</span>
        <span className={INNER}>
          <span>Held by</span>
          <span>Why</span>
          <span>Since</span>
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-line border-b border-line" aria-label="Held">
        {orderHolds(holds).map((hold) => (
          <HoldRow key={hold.issueId} hold={hold} slug={slug} now={now} />
        ))}
      </ul>
    </div>
  );
}
