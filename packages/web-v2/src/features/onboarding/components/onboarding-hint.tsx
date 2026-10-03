"use client";

// The dashboard's one line about onboarding (workflow project-onboarding, BC-1): never a blocker,
// derived by core from the onboarding's own rows, gone once every onboarding design is approved.
// Its link opens the onboarding thread in the chat panel, starting onboarding first when asked.

import type { OnboardingHint as Hint } from "@forge/contracts/onboarding";
import { useChatDock } from "@/features/conversations/dock";
import { refusalsOf } from "@/lib/api/refusals";
import { formatApiError } from "@/lib/api/error";
import { onboardingApi } from "../api";
import { useOnboardingState, useStartOnboarding } from "../hooks";

const TONE: Record<Hint["tone"], { bg: string; dot: string }> = {
  you: { bg: "var(--amberw-50)", dot: "var(--amberw-500)" },
  attention: { bg: "var(--amberw-50)", dot: "var(--red-500)" },
  run: { bg: "var(--cobalt-50)", dot: "var(--cobalt-500)" },
  ready: { bg: "var(--green-50)", dot: "var(--green-500)" },
  done: { bg: "var(--bg-sunken)", dot: "var(--ink-400)" },
  neutral: { bg: "var(--bg-sunken)", dot: "var(--ink-400)" },
  err: { bg: "var(--red-50)", dot: "var(--red-500)" },
};

/** Opens the project's onboarding thread in the panel: start it, or join it, then show the room. */
export function useOpenOnboarding(projectId: string) {
  const dock = useChatDock();
  const start = useStartOnboarding(projectId);
  const open = async (action: Hint["action"]) => {
    const res = action === "start" ? await start.mutateAsync() : await onboardingApi.join(projectId);
    dock?.show({ kind: "room", projectId, conversationId: res.onboarding.conversationId });
  };
  return { open, pending: start.isPending, error: start.error };
}

export function OnboardingHint({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useOnboardingState(projectId);
  const { open, pending, error } = useOpenOnboarding(projectId);
  const hint = q.data?.hint;
  if (!hint) return null;
  const t = TONE[hint.tone];
  const refusal = error ? (refusalsOf(error)[0]?.detail ?? formatApiError(error)) : null;
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
            onClick={() => void open(hint.action).catch(() => undefined)}
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
