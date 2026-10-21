"use client";

// The project's Pipeline page (`/projects/[slug]/pipeline`, ISS-1228): which agent sessions are live
// and what each is doing, then what is held and why. Read from one route; live through the project
// room's invalidations and a poll for heartbeats, which move no event.

import { ErrorState, LiveDot, PageTitle, Skeleton, StaleReadLine } from "@/design";
import { useNow } from "@/design/hooks/use-now";
import { readFailure } from "@/lib/api/error";
import { offersRetry, projectGone } from "@/lib/api/read-failed";
import { ProjectMissing } from "@/features/projects/components/project-missing";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { readAtLine } from "../derive";
import { useSessionsAndHolds } from "../hooks";
import { HoldsList } from "./holds-list";
import { SessionsList } from "./sessions-list";

function SectionHeading({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <h2 id={id} className="fg-h3 mb-2 flex items-baseline gap-2">
      {title}
      {count !== undefined && <span className="fg-caption tabular-nums">{count}</span>}
    </h2>
  );
}

function PlaceholderRows() {
  return (
    <div className="flex flex-col divide-y divide-line border-y border-line" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="py-3">
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      ))}
    </div>
  );
}

export function PipelineScreen({ scope }: { scope: { projectId: string; slug: string } }) {
  const { projectId, slug } = scope;
  useRoom(projectRoom(projectId));
  const q = useSessionsAndHolds(projectId);
  const now = useNow(10_000);
  const data = q.data;
  const failure = !data && q.isError ? readFailure(q.error) : null;

  // The project's own read answering 404 is the project gone: the page says so once, with nothing to act on (ISS-1228 r26).
  if (q.isError && projectGone(q.error)) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <ProjectMissing slug={slug} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-8 px-4 pb-10 pt-5 sm:px-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <PageTitle className="fg-h2">Pipeline</PageTitle>
          {data && !q.isError && <LiveDot state="live" />}
        </div>
        <p className="fg-body-sm">What is working on this project now, and what is held.</p>
        {data && q.isError && (
          <StaleReadLine
            said={readAtLine(data.readAt, q.error)}
            onRetry={offersRetry(q.error) ? () => void q.refetch() : undefined}
          />
        )}
      </header>

      {failure ? (
        <ErrorState
          title="Couldn't read sessions and holds"
          message={failure.said}
          technical={failure.technical}
          onRetry={offersRetry(q.error) ? () => void q.refetch() : undefined}
        />
      ) : (
        <>
          <section aria-labelledby="pipeline-sessions">
            <SectionHeading id="pipeline-sessions" title="Live sessions" count={data?.sessions.length} />
            {data ? <SessionsList sessions={data.sessions} slug={slug} now={now} /> : <PlaceholderRows />}
          </section>
          <section aria-labelledby="pipeline-holds">
            <SectionHeading id="pipeline-holds" title="Held" count={data?.holds.length} />
            {data ? <HoldsList holds={data.holds} sessions={data.sessions} slug={slug} now={now} /> : <PlaceholderRows />}
          </section>
        </>
      )}
    </div>
  );
}
