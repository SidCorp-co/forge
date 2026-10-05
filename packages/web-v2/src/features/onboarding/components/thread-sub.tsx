"use client";

// Under a room's title: who answers in it, and the thread's status (In progress, Waiting on you,
// Done), the badge the conversation list carries too.

import { useOnboardingState } from "../hooks";
import type { OnboardingStatus } from "../types";
import { HoverNote, ThreadStatusChip } from "./marks";

export function ThreadSub({
  kind,
  status,
  projectId,
}: {
  kind: "onboarding" | "requirement" | "first_requirements" | null | undefined;
  status: OnboardingStatus | null | undefined;
  projectId?: string;
}) {
  if (!kind && !status) return null;
  const ba = kind === "requirement" || kind === "first_requirements";
  return (
    <div className="mt-0.5 flex flex-col gap-0.5" data-testid="thread-sub">
      <ThreadSubLine ba={ba} status={status} />
      {(kind === "onboarding" || kind === "first_requirements") && projectId && <OverdueLine projectId={projectId} kind={kind} />}
    </div>
  );
}

// The onboarding read model's own due rule (openBatch.overdue): the same one that turns the dashboard
// hint to attention, for the onboarding thread and the first-requirements room. A line, never a blocker.
function OverdueLine({ projectId, kind }: { projectId: string; kind: "onboarding" | "first_requirements" }) {
  const state = useOnboardingState(projectId).data;
  const batch = kind === "onboarding" ? state?.onboarding?.openBatch : state?.firstRequirements?.openBatch;
  if (!batch?.overdue) return null;
  return (
    <p className="text-[11.5px] text-[color:var(--red-600)]" data-testid="thread-overdue">
      {`Questions waiting ${batch.waitingDays} days · ${batch.open} open`}
      <span className="text-subtle">{" · answer when you can; the project works meanwhile"}</span>
    </p>
  );
}

function ThreadSubLine({ ba, status }: { ba: boolean; status: OnboardingStatus | null | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle">
      <HoverNote label={ba ? "With BA assistant" : "With Agent"}>
        {ba
          ? "The BA assistant reads the approved designs or this requirement and proposes; a person accepts or rejects."
          : "The project's resident agent. It only suggests: designs change when an approver approves them."}
      </HoverNote>
      {status && <ThreadStatusChip status={status} />}
    </div>
  );
}
