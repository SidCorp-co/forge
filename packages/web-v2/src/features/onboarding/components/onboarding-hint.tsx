"use client";

// The dashboard's one line about onboarding (workflow project-onboarding, BC-1): never a blocker,
// derived by core from the onboarding's own rows, gone once every onboarding design is approved.
// Its link opens the onboarding thread in the chat panel, starting onboarding first when asked.

import type { OnboardingHint as Hint, OnboardingStateResponse } from "@forge/contracts/onboarding";
import { LEGEND } from "@/design";
import { useChatDock } from "@/features/chat-dock/dock";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useOnboardingState } from "../hooks";
import { useAskForDesigns } from "./ask-for-designs";

const TONE: Record<Hint["tone"], { bg: string; dot: string }> = {
  ...LEGEND,
  attention: { bg: LEGEND.you.bg, dot: LEGEND.err.dot },
};


/** project-onboarding `req-result`, read from core once the designs are approved: one line, never a blocker. */
function FirstRequirementsLine({ projectId, first }: { projectId: string; first: OnboardingStateResponse["firstRequirements"] }) {
  const dock = useChatDock();
  const copy = useCopy();
  if (!first || (first.status === "none" && !first.openBatch)) return null;
  const t = TONE[first.openBatch?.overdue ? "attention" : first.status === "suggested" || first.openBatch ? "you" : "ready"];
  return (
    <div className="px-4 py-2.5 sm:px-6" style={{ background: t.bg }} data-testid="first-requirements-line" data-status={first.status}>
      <p className="flex items-baseline gap-2 text-[13.5px] text-fg">
        <span aria-hidden className="size-2 flex-none translate-y-[-1px] rounded-full" style={{ background: t.dot }} />
        <span className="min-w-0">
          <span className="font-bold">{copy("onboarding.first.lead")}</span> {copy(`onboarding.first.${first.status}`, { n: first.suggested })}
          {first.openBatch && ` · ${copy("onboarding.first.openQuestions", { n: first.openBatch.open })}${first.openBatch.overdue ? ` · ${copy("onboarding.first.waitingDays", { n: first.openBatch.waitingDays })}` : ""}`} ·{" "}
          <button type="button" className="font-medium text-link hover:underline" onClick={() => dock?.show({ kind: "room", projectId, conversationId: first.conversationId })}>
            {copy("onboarding.first.openRoom")}
          </button>
        </span>
      </p>
    </div>
  );
}

export function OnboardingHint({ projectId, projectName }: { projectId: string; projectName: string }) {
  const q = useOnboardingState(projectId);
  const { ask, dialog, pending, error } = useAskForDesigns(projectId);
  const copy = useCopy();
  const language = useInterfaceLanguage();
  const hint = q.data?.hint;
  if (!hint) return <FirstRequirementsLine projectId={projectId} first={q.data?.firstRequirements ?? null} />;
  const t = TONE[hint.tone];
  return (
    <div className="px-4 py-2.5 sm:px-6" style={{ background: t.bg }} data-testid="onboarding-hint">
      <div className="flex items-baseline gap-2 text-[13.5px] text-fg">
        <span aria-hidden className="size-2 flex-none translate-y-[-1px] rounded-full" style={{ background: t.dot }} />
        <p className="min-w-0">
          <span className="font-bold">{said(hint.says.lead, language)}</span> {said(hint.says.text, language)} ·{" "}
          <button
            type="button"
            className="font-medium text-link hover:underline disabled:opacity-60"
            disabled={pending}
            onClick={() => ask(hint.action)}
            data-testid="onboarding-hint-action"
          >
            {said(hint.says.actionLabel, language)}
          </button>
          {hint.mayReanalyze && hint.action !== "reanalyze" && (
            <>
              {" · "}
              <button
                type="button"
                className="text-link hover:underline disabled:opacity-60"
                disabled={pending}
                title={copy("onboarding.hint.reanalyzeTitle")}
                onClick={() => ask("reanalyze")}
              >
                {copy("onboarding.hint.reanalyze")}
              </button>
            </>
          )}
        </p>
      </div>
      <p className="mt-1 flex items-center gap-1.5 pl-4 text-[11.5px] text-subtle">
        <span aria-hidden className="text-[color:var(--ai-bar)]">
          ✦
        </span>
        {copy("onboarding.hint.master", { name: projectName })}
      </p>
      {error && (
        <p role="alert" className="mt-1 pl-4 text-[12px] text-[color:var(--red-600)]">
          {error}
        </p>
      )}
      {dialog}
    </div>
  );
}
