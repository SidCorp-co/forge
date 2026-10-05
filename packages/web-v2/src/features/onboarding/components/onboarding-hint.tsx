"use client";

// The dashboard's one line about onboarding (workflow project-onboarding, BC-1): never a blocker,
// derived by core from the onboarding's own rows, gone once every onboarding design is approved.
// Its link opens the onboarding thread in the chat panel, starting onboarding first when asked.

import type { OnboardingHint as Hint } from "@forge/contracts/onboarding";
import { LEGEND } from "@/design";
import { useChatDock } from "@/features/conversations/dock";
import { refusalsOf } from "@/lib/api/refusals";
import { formatApiError } from "@/lib/api/error";
import { useJoinOnboarding, useOnboardingState, useStartOnboarding } from "../hooks";

const TONE: Record<Hint["tone"], { bg: string; dot: string }> = {
  ...LEGEND,
  attention: { bg: LEGEND.you.bg, dot: LEGEND.err.dot },
};

/**
 * Opens the project's onboarding thread in the panel: start it, or join it, then show the room.
 * A refused start or join is the hook's `error`, shown by name; `open` never rejects.
 */
export function useOpenOnboarding(projectId: string) {
  const dock = useChatDock();
  const start = useStartOnboarding(projectId);
  const join = useJoinOnboarding(projectId);
  const open = async (action: Hint["action"]) => {
    const act = action === "start" ? start : join;
    const other = action === "start" ? join : start;
    other.reset();
    const res = await act.mutateAsync().catch(() => null);
    if (res) dock?.show({ kind: "room", projectId, conversationId: res.onboarding.conversationId });
    return res !== null;
  };
  return { open, pending: start.isPending || join.isPending, error: start.error ?? join.error };
}

/** The line a refused start or join shows: the refusal's own detail, else the error's message. */
export function refusalLine(error: unknown): string | null {
  return error ? (refusalsOf(error)[0]?.detail ?? formatApiError(error)) : null;
}

export function OnboardingHint({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useOnboardingState(projectId);
  const { open, pending, error } = useOpenOnboarding(projectId);
  const hint = q.data?.hint;
  if (!hint) return null;
  const t = TONE[hint.tone];
  const refusal = refusalLine(error);
  return (
    <div className="px-4 py-2.5 sm:px-6" style={{ background: t.bg }} data-testid="onboarding-hint">
      <div className="flex items-baseline gap-2 text-[13.5px] text-fg">
        <span aria-hidden className="size-2 flex-none translate-y-[-1px] rounded-full" style={{ background: t.dot }} />
        <p className="min-w-0">
          <span className="font-bold">{hint.lead}</span> {hint.text} ·{" "}
          <button
            type="button"
            className="font-medium text-link hover:underline disabled:opacity-60"
            disabled={pending}
            onClick={() => void open(hint.action)}
          >
            {hint.actionLabel}
          </button>
        </p>
      </div>
      <p className="mt-1 flex items-center gap-1.5 pl-4 text-[11.5px] text-subtle">
        <span aria-hidden className="text-[color:var(--ai-bar)]">
          ✦
        </span>
        Master {projectName}
      </p>
      {refusal && (
        <p role="alert" className="mt-1 pl-4 text-[12px] text-[color:var(--red-600)]">
          {refusal}
        </p>
      )}
    </div>
  );
}
