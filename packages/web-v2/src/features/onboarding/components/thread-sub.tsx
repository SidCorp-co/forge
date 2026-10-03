"use client";

// Under a room's title: who answers in it, and the thread's status (In progress, Waiting on you,
// Done), the badge the conversation list carries too.

import type { OnboardingStatus } from "../types";
import { HoverNote, ThreadStatusChip } from "./marks";

export function ThreadSub({
  kind,
  status,
}: {
  kind: "onboarding" | "requirement" | null | undefined;
  status: OnboardingStatus | null | undefined;
}) {
  if (!kind && !status) return null;
  const ba = kind === "requirement";
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle" data-testid="thread-sub">
      <HoverNote label={ba ? "With BA assistant" : "With Agent"}>
        {ba
          ? "The BA assistant reads this requirement and proposes; a person accepts or rejects."
          : "The project's resident agent. It only suggests: designs change when a person approves them."}
      </HoverNote>
      {status && <ThreadStatusChip status={status} />}
    </div>
  );
}
