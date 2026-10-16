"use client";

// The dashboard's live block reads the sessions the Pipeline page lists, so the two count the same
// work: a driver run holds no job, so a count of jobs cannot say whether anything is working it. The
// open runs nothing works are a count under the block, never a row.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon, LiveDot, MonoTag, SILENCE_TONE, SILENCE_WORD } from "@/design";
import { TONE_META } from "@/design/status";
import { checkInOf, doingOf, orderSessions, sessionName } from "@/features/pipeline/derive";
import type { LiveSession } from "@/features/pipeline/types";
import type { PipelineRunListItem } from "@/features/runs/types";
import type { ReadState } from "../shape";
import { DashboardSection, EmptyLine, RowList, unreadSection } from "./dashboard-section";

export interface LiveSessionsCardProps {
  sessions: readonly LiveSession[];
  slug: string;
  now: number;
  /** Open runs nothing works: no live job and no session on them. Shown as a count rather than hidden. */
  idle?: readonly PipelineRunListItem[];
  /** The sessions read. Until it is in, the section says so and states no session and none live. */
  read?: ReadState;
  /** The runs read, which the idle count stands on: no count is said until it is in. */
  runsRead?: ReadState;
}

function SessionRow({ session, slug, now }: { session: LiveSession; slug: string; now: number }) {
  const doing = doingOf(session, now);
  const checkIn = checkInOf(session, now);
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2" data-session-id={session.id}>
      <span className="fg-body-sm flex w-[9.5rem] flex-none items-center gap-1.5 text-fg">
        <span
          aria-hidden="true"
          className="size-[7px] flex-none rounded-pill"
          style={{ background: TONE_META[doing.tone].dot }}
        />
        {doing.label}
      </span>
      <Link
        href={`/projects/${slug}/agents/${session.id}`}
        className="fg-body-sm min-w-0 flex-1 basis-40 truncate text-fg hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        {sessionName(session)}
      </Link>
      {session.issues.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
          {session.issues.map((issue) => (
            <Link
              key={issue.issueId}
              href={`/projects/${slug}/issues/${issue.issueId}`}
              title={issue.title}
              className="hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
            >
              <MonoTag>{issue.displayId}</MonoTag>
            </Link>
          ))}
        </span>
      )}
      <span
        className="fg-caption ml-auto flex-none tabular-nums"
        style={checkIn.quiet ? { color: TONE_META[SILENCE_TONE].fg } : undefined}
      >
        {checkIn.quiet ? `${SILENCE_WORD} · ${checkIn.text}` : checkIn.text}
      </span>
    </li>
  );
}

export function LiveSessionsCard({ sessions, slug, now, idle = [], read, runsRead }: LiveSessionsCardProps) {
  const router = useRouter();

  const idleNote = runsRead?.read !== "pending" && runsRead?.read !== "failed" && idle.length > 0 && (
    <button
      type="button"
      onClick={() => router.push(`/projects/${slug}/agents`)}
      className="fg-caption mt-1 flex w-full items-center gap-1.5 rounded-md py-2 text-left text-muted transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <Icon name="pause" size={13} className="flex-none text-subtle" />
      <span className="min-w-0 flex-1">
        {idle.length} open {idle.length === 1 ? "run has" : "runs have"} nothing working {idle.length === 1 ? "it" : "them"}
      </span>
      <Icon name="chevronRight" size={13} className="flex-none text-subtle" />
    </button>
  );

  const unread = unreadSection("Live sessions", "The project's live sessions", read, true);
  if (unread) return unread;

  if (sessions.length === 0) {
    return (
      <div>
        <EmptyLine title="Live sessions" status="none live right now" />
        {idleNote}
      </div>
    );
  }

  return (
    <DashboardSection title="Live sessions" aside={<LiveDot state="live" />}>
      <RowList>
        {orderSessions(sessions).map(({ session }) => (
          <SessionRow key={session.id} session={session} slug={slug} now={now} />
        ))}
      </RowList>
      {idleNote}
    </DashboardSection>
  );
}
