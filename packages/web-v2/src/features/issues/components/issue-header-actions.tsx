"use client";

import { Button, ButtonLink, IconButton, Menu, type MenuItem, Skeleton } from "@/design";
import { couldNotRead } from "@/lib/api/read-failed";
import { useRouter } from "next/navigation";
import type { IssueStatus } from "../types";

/**
 * The issue page header's primary action, Open session (the session holding the issue, else its
 * newest), and the actions menu. At Releasing a release run carries the issue and only that run's
 * finish or abort takes it out (ISS-1421), so the header offers the run itself and no move: core
 * would refuse Pause and Reopen there by name.
 * At Awaiting release the page's primary is the banner's Release now, so Reopen sits in the menu.
 */
export function IssueHeaderActions({
  slug,
  sessionHref,
  sessionUnread,
  status,
  releaseRunId,
  canWrite,
  pending,
  isRunActive,
  runWaitsOn = null,
  onAnswer,
  runsUnreadable = false,
  onTransition,
  onRun,
  running,
  onCopyLink,
}: {
  slug: string;
  sessionHref: string | null;
  /** Which session holds the issue could not be read: said, with why and Retry, where Open session goes. */
  sessionUnread?: { error: unknown; retry?: (() => void) | undefined } | undefined;
  status: IssueStatus;
  releaseRunId: string | null | undefined;
  canWrite: boolean;
  pending: boolean;
  /** Whether a run is active; null until the run journal has answered, when no run action is offered. */
  isRunActive: boolean | null;
  /** What the run waits on: an answer makes Answer the primary, nothing working offers none (ISS-1228). */
  runWaitsOn?: "answer" | "nothing" | null;
  /** Bring the question the run waits on into view. */
  onAnswer?: () => void;
  /** The run journal's first read failed: the action's place offers reading it again. */
  runsUnreadable?: boolean;
  onTransition: (to: IssueStatus) => void;
  /** Offer the issue to the project's masters; only at Open, the one status a press can start. */
  onRun: () => void;
  running: boolean;
  onCopyLink: () => void;
}) {
  const router = useRouter();
  const isTerminal = status === "awaiting_release" || status === "closed";
  const isReleasing = status === "releasing";
  const movable = canWrite && !isTerminal && !isReleasing;
  const reopenable = movable || (canWrite && status === "awaiting_release");
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);

  const moreItems: MenuItem[] = [
    { label: "Open pipeline", icon: "pipeline", onSelect: openPipeline },
    ...(movable && status !== "on_hold"
      ? [{ label: "Pause (hold)", icon: "stop", onSelect: () => onTransition("on_hold") } as MenuItem]
      : []),
    ...(reopenable
      ? [{ label: "Reopen", icon: "rerun", onSelect: () => onTransition("reopen") } as MenuItem]
      : []),
    { label: "Copy link", icon: "link", onSelect: onCopyLink },
  ];

  return (
    <>
      <PrimaryAction
        isReleasing={isReleasing}
        atGate={status === "awaiting_release"}
        releaseRunId={releaseRunId}
        canWrite={canWrite}
        isTerminal={isTerminal}
        isRunActive={isRunActive}
        runWaitsOn={runWaitsOn}
        onAnswer={onAnswer}
        runsUnreadable={runsUnreadable}
        pending={pending}
        onTransition={onTransition}
        atEntry={status === "open"}
        onRun={onRun}
        running={running}
        openPipeline={openPipeline}
        openRelease={(runId) => router.push(`/projects/${slug}/releases/${runId}`)}
      />
      {/* Its words at every width: the release banner sends a reader to "Open session at the top
          of this page", so at 390 it cannot be an icon alone (ISS-1421 round 6, criterion 86). */}
      {/* A link, so it opens in a new tab and copies as the session's address (ISS-1228). */}
      {sessionHref && (
        <ButtonLink href={sessionHref} variant="secondary" size="sm" icon="agent">
          Open session
        </ButtonLink>
      )}
      {sessionUnread && (
        <span role="status" className="fg-caption inline-flex flex-wrap items-center gap-2 text-muted">
          {couldNotRead("Its session", sessionUnread.error)}
          {sessionUnread.retry && (
            <Button variant="secondary" size="sm" icon="rerun" onClick={sessionUnread.retry}>
              Retry
            </Button>
          )}
        </span>
      )}
      <Menu
        align="right"
        items={moreItems}
        trigger={<IconButton icon="more" aria-label="Issue actions" />}
      />
    </>
  );
}

function PrimaryAction(props: {
  isReleasing: boolean;
  atGate: boolean;
  releaseRunId: string | null | undefined;
  canWrite: boolean;
  isTerminal: boolean;
  isRunActive: boolean | null;
  runWaitsOn: "answer" | "nothing" | null;
  onAnswer: (() => void) | undefined;
  runsUnreadable: boolean;
  pending: boolean;
  onTransition: (to: IssueStatus) => void;
  atEntry: boolean;
  onRun: () => void;
  running: boolean;
  openPipeline: () => void;
  openRelease: (runId: string) => void;
}) {
  const { releaseRunId, pending, onTransition } = props;
  if (props.isReleasing) {
    return releaseRunId ? (
      <Button variant="primary" size="sm" icon="pipeline" onClick={() => props.openRelease(releaseRunId)}>
        View release
      </Button>
    ) : null;
  }
  if (!props.canWrite) {
    return (
      <Button variant="primary" size="sm" icon="pipeline" onClick={props.openPipeline}>
        View pipeline
      </Button>
    );
  }
  if (props.atGate) return null;
  if (props.isTerminal) {
    return (
      <Button variant="primary" size="sm" icon="rerun" loading={pending} onClick={() => onTransition("reopen")}>
        Reopen
      </Button>
    );
  }
  // Pause, Run and Open pipeline each say something about the run: none is offered before it is read.
  if (props.isRunActive === null) {
    // Unreadable, the Retry stands beside the chip row's "could not be read", for every reader.
    return props.runsUnreadable ? null : (
      <span role="status" aria-label="Reading the run" className="inline-flex">
        <Skeleton className="h-8 w-28" />
      </span>
    );
  }
  // A run waiting on a person's answer asks for that answer; one nothing works offers no act beside its
  // word. Pause stays in the menu on both (ISS-1228 round 21).
  if (props.runWaitsOn === "answer" && props.onAnswer) {
    return (
      <Button variant="primary" size="sm" icon="mail" onClick={props.onAnswer}>
        Answer
      </Button>
    );
  }
  if (props.runWaitsOn === "nothing") return null;
  if (props.isRunActive) {
    return (
      <Button variant="secondary" size="sm" icon="stop" loading={pending} onClick={() => onTransition("on_hold")}>
        Pause
      </Button>
    );
  }
  // Run asks core to offer the issue to the masters and says what came back; anywhere else the
  // primary opens the Pipeline page and is named for that (ISS-1228 round 11).
  if (props.atEntry) {
    return (
      <Button variant="primary" size="sm" icon="play" loading={props.running} onClick={props.onRun}>
        Run
      </Button>
    );
  }
  return (
    <Button variant="primary" size="sm" icon="pipeline" onClick={props.openPipeline}>
      Open pipeline
    </Button>
  );
}
