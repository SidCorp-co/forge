"use client";

import { Button } from "@/design";
import type { V1Read } from "@/features/project-settings/config-types";
import type { ProjectMember } from "@/features/projects/types";
import { canWriteProject } from "@/features/projects/write-access";
import { formatRelativeTime } from "@/lib/utils/format";
import { useRunPipelineStep } from "../hooks";
import type { IssueStatus } from "../types";

type Role = ProjectMember["role"] | null | undefined;

export type StartReading =
  | { kind: "none" }
  | { kind: "start" }
  | { kind: "started"; startedAt: string }
  | { kind: "waits" }
  | { kind: "unread"; reason: string };


export function intakeIsManual(policy: V1Read | undefined): boolean {
  if (!policy?.declared) return false;
  const intake = policy.document.intake as { mode?: unknown } | undefined;
  return intake?.mode === "manual";
}

function startedAtOf(sessionContext: Record<string, unknown> | null | undefined): string | null {
  const at = sessionContext?.runRelease;
  return typeof at === "string" ? at : null;
}

/** What the header offers for an issue waiting at Open on a project whose intake is manual. */
export function readStart(args: {
  status: IssueStatus;
  policy: V1Read | undefined;
  policyError?: Error | null;
  role: Role;
  sessionContext: Record<string, unknown> | null | undefined;
}): StartReading {
  if (args.status !== "open") return { kind: "none" };
  if (args.policyError) return { kind: "unread", reason: args.policyError.message };
  if (!intakeIsManual(args.policy)) return { kind: "none" };
  const startedAt = startedAtOf(args.sessionContext);
  if (startedAt) return { kind: "started", startedAt };
  return canWriteProject(args.role) ? { kind: "start" } : { kind: "waits" };
}

export function StartIssueAction({
  issueId,
  reading,
  onStarted,
}: {
  issueId: string;
  reading: StartReading;
  onStarted: () => void;
}) {
  const start = useRunPipelineStep();
  if (reading.kind === "start") {
    return (
      <Button
        variant="primary"
        size="sm"
        icon="play"
        loading={start.isPending}
        onClick={() => start.mutate({ id: issueId }, { onSuccess: onStarted })}
      >
        Start
      </Button>
    );
  }
  if (reading.kind === "started") {
    return (
      <span className="fg-caption" title={reading.startedAt}>
        Started {formatRelativeTime(reading.startedAt)} · waiting for a runner
      </span>
    );
  }
  if (reading.kind === "waits") {
    return <span className="fg-caption">Waits for a project member to start it</span>;
  }
  if (reading.kind === "unread") {
    return (
      <span className="fg-caption" role="alert" title={reading.reason}>
        Intake policy could not be read, so whether this issue waits for a Start is unknown
      </span>
    );
  }
  return null;
}
