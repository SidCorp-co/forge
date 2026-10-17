"use client";

import Link from "next/link";
import { MonoTag, SILENCE_TONE, SILENCE_WORD } from "@/design";
import { TONE_META } from "@/design/status";
import {
  checkInOf,
  orderSessions,
  sessionKindLabel,
  sessionName,
  waitingOnOf,
} from "../derive";
import { leaseDisagreementText } from "@/features/sessions/status-sentences";
import { liveSessionWord } from "@/features/sessions/session-word";
import type { LiveSession } from "../types";

const COLUMNS =
  "sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.9fr)] sm:gap-4";

/** A field's name, said on a phone where there is no column header to say it. */
function Label({ children }: { children: string }) {
  return <span className="fg-caption mr-1.5 flex-none sm:sr-only">{children}</span>;
}

function SessionRow({
  session,
  depth,
  slug,
  now,
}: {
  session: LiveSession;
  depth: 0 | 1;
  slug: string;
  now: number;
}) {
  const doing = liveSessionWord(session, now);
  const waiting = waitingOnOf(session);
  const checkIn = checkInOf(session, now);
  const name = sessionName(session);
  const disagreement = leaseDisagreementText(
    session.issues.filter((i) => i.boxReturned).map((i) => i.displayId),
  );
  return (
    <li className={`flex flex-col gap-1.5 py-3 ${COLUMNS} sm:items-baseline`} data-session-id={session.id}>
      <div className={`min-w-0 ${depth === 1 ? "sm:pl-5" : ""}`}>
        <Link
          href={`/projects/${slug}/agents/${session.id}`}
          className="fg-label block truncate hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {depth === 1 && <span aria-hidden="true" className="mr-1 text-subtle">└</span>}
          {name}
        </Link>
        <span className="fg-caption block truncate">
          {sessionKindLabel(session.kind)} · {session.deviceName ?? "an unnamed box"}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline">
          <Label>On</Label>
          {session.issues.length === 0 ? (
            <span className="fg-body-sm">No issue held</span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
              {session.issues.map((issue) => (
                <Link
                  key={issue.issueId}
                  href={`/projects/${slug}/issues/${issue.issueId}`}
                  className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  title={issue.title}
                >
                  <span className="flex-none whitespace-nowrap">
                    <MonoTag>{issue.displayId}</MonoTag>
                  </span>
                  {session.issues.length === 1 && (
                    <span className="fg-body-sm min-w-0 truncate">{issue.title}</span>
                  )}
                </Link>
              ))}
            </span>
          )}
        </div>
        {disagreement && <p className="fg-caption mt-1 break-words text-muted">{disagreement}</p>}
      </div>
      <div className="fg-body-sm flex items-center gap-1.5 text-fg">
        <Label>Doing</Label>
        <span
          aria-hidden="true"
          className="size-[7px] flex-none rounded-pill"
          style={{ background: TONE_META[doing.tone].dot }}
        />
        {doing.label}
      </div>
      <div className="fg-body-sm min-w-0">
        <Label>Waiting on</Label>
        {waiting.blocked ? waiting.text : <span className="text-subtle">{waiting.text}</span>}
      </div>
      <div className="fg-body-sm">
        <Label>Last check-in</Label>
        {checkIn.quiet ? (
          <span className="font-semibold" style={{ color: TONE_META[SILENCE_TONE].fg }}>
            {SILENCE_WORD} · {checkIn.text}
          </span>
        ) : (
          checkIn.text
        )}
      </div>
    </li>
  );
}

export function SessionsList({
  sessions,
  slug,
  now,
}: {
  sessions: LiveSession[];
  slug: string;
  now: number;
}) {
  if (sessions.length === 0) {
    return <p className="fg-body-sm border-y border-line py-4">No session is live on this project.</p>;
  }
  return (
    <div>
      <div className={`fg-caption hidden border-b border-line pb-2 ${COLUMNS}`} aria-hidden="true">
        <span>Session</span>
        <span>On</span>
        <span>Doing</span>
        <span>Waiting on</span>
        <span>Last check-in</span>
      </div>
      <ul className="flex flex-col divide-y divide-line border-b border-line" aria-label="Live sessions">
        {orderSessions(sessions).map(({ session, depth }) => (
          <SessionRow key={session.id} session={session} depth={depth} slug={slug} now={now} />
        ))}
      </ul>
    </div>
  );
}
