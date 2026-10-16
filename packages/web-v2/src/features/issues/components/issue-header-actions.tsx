"use client";

import { Button, IconButton, Menu, type MenuItem } from "@/design";
import { useRouter } from "next/navigation";
import type { IssueStatus } from "../types";

/**
 * The issue page header's primary action, Open session, and the actions menu. At Releasing a
 * release run carries the issue and only that run's finish or abort takes it out (ISS-1421), so
 * the header offers the run itself and no move: core would refuse Pause and Reopen there by name.
 * At Awaiting release the page's primary is the banner's Release now, so Reopen sits in the menu.
 */
export function IssueHeaderActions({
  slug,
  issueId,
  status,
  releaseRunId,
  canWrite,
  pending,
  isRunActive,
  onTransition,
  onRun,
  running,
  onCopyLink,
}: {
  slug: string;
  issueId: string;
  status: IssueStatus;
  releaseRunId: string | null | undefined;
  canWrite: boolean;
  pending: boolean;
  isRunActive: boolean;
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
        pending={pending}
        onTransition={onTransition}
        atEntry={status === "open"}
        onRun={onRun}
        running={running}
        openPipeline={openPipeline}
        openRelease={(runId) => router.push(`/projects/${slug}/releases/${runId}`)}
      />
      {/* Its label from `sm` up and its icon alone below, so at 390 the primary, this and the
          actions menu keep one row beside the help button (ISS-1421 round 2). */}
      <Button
        variant="secondary"
        size="sm"
        icon="agent"
        aria-label="Open session"
        title="Open session"
        onClick={() => router.push(`/projects/${slug}/agents?issue=${issueId}`)}
      >
        <span className="hidden sm:inline">Open session</span>
      </Button>
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
  isRunActive: boolean;
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
