"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { MonoTag } from "@/design";
import { holderLine, orderHolds } from "../derive";
import type { HeldIssue, Holder } from "../types";

const OUTER = "sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,3.8fr)] sm:gap-4";
const INNER = "sm:grid sm:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_minmax(0,0.6fr)] sm:gap-4";

/** One holder per kind and identity on an issue: a session, a claim's holder, a park's status. */
function holderKey(holder: Holder): string {
  if (holder.by === "session") return `session-${holder.sessionId}`;
  if (holder.by === "claim") return `claim-${holder.holder}`;
  return `person-${holder.status}`;
}

function Label({ children }: { children: string }) {
  return <span className="fg-caption mr-1.5 sm:sr-only">{children}</span>;
}

/**
 * A reason held to three lines: one sentence is read whole in place, and a claim's next step or a
 * park's reason that runs to a paragraph does not push every row below it down. Where the three
 * lines clip, a toggle opens the whole of it in place, so a phone with no hover reaches every word.
 */
function ClampedReason({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span
        ref={ref}
        className={open ? "min-w-0 whitespace-pre-line break-words" : "line-clamp-3 min-w-0 break-words"}
        title={open ? undefined : text}
      >
        {text}
      </span>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="fg-caption flex-none text-link hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </span>
  );
}

function HoldRow({ hold, slug, now }: { hold: HeldIssue; slug: string; now: number }) {
  return (
    <li className={`flex flex-col gap-2 py-3 ${OUTER}`} data-issue-id={hold.issueId}>
      <Link
        href={`/projects/${slug}/issues/${hold.issueId}`}
        className="flex min-w-0 items-baseline gap-2 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <span className="flex-none whitespace-nowrap">
          <MonoTag>{hold.displayId}</MonoTag>
        </span>
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
              <span className="flex min-w-0 items-baseline">
                <Label>Why</Label>
                <ClampedReason key={line.why} text={line.why} />
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
