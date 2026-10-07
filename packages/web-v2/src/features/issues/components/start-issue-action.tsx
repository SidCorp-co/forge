"use client";

import { Button } from "@/design";
import type { V1Read } from "@/features/project-config/types";
import type { ProjectMember } from "@/features/projects/types";
import { canWriteProject } from "@/features/projects/write-access";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRunPipelineStep } from "../hooks";
import type { IssueStatus } from "../types";

type Role = ProjectMember["role"] | null | undefined;

export type StartReading =
  | { kind: "none" }
  | { kind: "start" }
  | { kind: "started"; startedAt: string }
  | { kind: "waits" }
  | { kind: "unread"; reason: string };


function intakeIsManual(policy: V1Read | undefined): boolean {
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
  const t = useCopy();
  const time = useTimeFormat();
  if (reading.kind === "start") {
    return (
      <Button
        variant="primary"
        size="sm"
        icon="play"
        loading={start.isPending}
        onClick={() => start.mutate({ id: issueId }, { onSuccess: onStarted })}
      >
        {t("issues.start.start")}
      </Button>
    );
  }
  if (reading.kind === "started") {
    return (
      <span className="fg-caption" title={time.dateTime(reading.startedAt)}>
        {t("issues.start.started", { at: time.relative(reading.startedAt) })}
      </span>
    );
  }
  if (reading.kind === "waits") {
    return <span className="fg-caption">{t("issues.start.waits")}</span>;
  }
  if (reading.kind === "unread") {
    return (
      <span className="fg-caption" role="alert" title={reading.reason}>
        {t("issues.start.unread")}
      </span>
    );
  }
  return null;
}
