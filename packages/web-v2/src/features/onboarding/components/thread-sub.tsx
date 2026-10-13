
// Under a room's title: who answers in it, and the thread's status (In progress, Waiting on you,
// Done), the badge the conversation list carries too.

import { useCopy } from "@/lib/i18n/interface-language";
import { useOnboardingState } from "../hooks";
import type { OnboardingStatus } from "../types";
import { StatusBadge } from "@/design";

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
  const t = useCopy();
  const state = useOnboardingState(projectId).data;
  const batch = kind === "onboarding" ? state?.onboarding?.openBatch : state?.firstRequirements?.openBatch;
  if (!batch?.overdue) return null;
  return (
    <p className="text-12 text-danger-11" data-testid="thread-overdue">
      {t("conversations.sub.overdue", { days: batch.waitingDays, open: batch.open })}
    </p>
  );
}

function ThreadSubLine({ ba, status }: { ba: boolean; status: OnboardingStatus | null | undefined }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-12 text-subtle">
      <span>{ba ? t("conversations.sub.withBa") : t("conversations.sub.withAgent")}</span>
      {status && <StatusBadge family="thread" value={status} />}
    </div>
  );
}
