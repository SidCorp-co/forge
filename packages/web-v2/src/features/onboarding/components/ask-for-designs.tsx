"use client";

import type { OnboardingHint } from "@forge/contracts/onboarding";
import { ONBOARDING_REQUEST_MAX } from "@forge/contracts/onboarding";
import { type ReactNode, useId, useState } from "react";
import { ConfirmDialog, Textarea } from "@/design";
import { useChatDock } from "@/features/chat-dock/dock";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useJoinOnboarding, useReanalyze, useStartOnboarding } from "../hooks";

type Spend = "start" | "reanalyze";

const COPY: Record<Spend, { title: string; does: string; field: string; placeholder: string; confirm: string }> = {
  start: {
    title: "Ask for the first designs",
    does:
      "One analysis job reads the project's code on its default branch, writes a code map, and drafts the key designs: the system context, the main journey and the central entity's states, plus an integration or data-flow design where the code calls for one. Every design arrives proposed for your review; nothing is approved for you. Then it asks what the code cannot tell, in one questionnaire in the onboarding chat.",
    field: "What should the drafts cover? (optional)",
    placeholder: "For example: draw against REQ-1, and leave every design proposed for my review.",
    confirm: "Start the analysis",
  },
  reanalyze: {
    title: "Ask for a re-analysis",
    does:
      "One new analysis job reads the code again and proposes new revisions of the designs. An approved revision is never overwritten, and an open questionnaire is replaced by the new one.",
    field: "Why, or what to look at again (optional)",
    placeholder: "For example: the order module was rewritten last week.",
    confirm: "Start the re-analysis",
  },
};

const COST =
  "It runs one job on the project's runner box, up to an hour of an agent's time. Nothing starts until you confirm; you can keep writing to the job in the onboarding chat while it runs.";

/** The refusal a start, join or re-analysis came back with, by name. */
export function refusalLine(error: unknown): string | null {
  return error ? (refusalsOf(error)[0]?.detail ?? formatApiError(error)) : null;
}

/**
 * Every way into onboarding. Opening a thread that exists costs nothing and happens at once; starting
 * one, or asking for a re-analysis, runs a job on the box, so it is confirmed first, with what the job
 * will do and the person's own request, which reaches the job as the first message of the thread.
 */
export function useAskForDesigns(projectId: string, opts: { onOpened?: () => void; conversationId?: string } = {}) {
  const dock = useChatDock();
  const start = useStartOnboarding(projectId);
  const join = useJoinOnboarding(projectId);
  const reanalyze = useReanalyze(projectId, opts.conversationId);
  const [asking, setAsking] = useState<Spend | null>(null);
  const [text, setText] = useState("");
  const fieldId = useId();

  const show = (conversationId: string) => {
    dock?.show({ kind: "room", projectId, conversationId });
    opts.onOpened?.();
  };
  const reset = () => {
    for (const m of [start, join, reanalyze]) m.reset();
  };

  const ask = (action: OnboardingHint["action"]) => {
    reset();
    if (action === "start" || action === "reanalyze") {
      setText("");
      setAsking(action);
      return;
    }
    join.mutate(undefined, { onSuccess: (res) => show(res.onboarding.conversationId) });
  };

  const spend = asking === "reanalyze" ? reanalyze : start;
  const confirm = () => {
    const said = text.trim() || undefined;
    spend.mutate(said, {
      onSuccess: (res) => {
        setAsking(null);
        show(res.onboarding.conversationId);
      },
    });
  };

  const copy = asking ? COPY[asking] : null;
  const refused = refusalLine(spend.error);
  const dialog: ReactNode = copy ? (
    <ConfirmDialog
      open
      title={copy.title}
      confirmLabel={copy.confirm}
      loading={spend.isPending}
      onConfirm={confirm}
      onClose={() => setAsking(null)}
      message={
        <div className="grid gap-3" data-testid="ask-for-designs">
          <p className="m-0">{copy.does}</p>
          <p className="m-0 text-muted">{COST}</p>
          <label htmlFor={fieldId} className="grid gap-1.5">
            <span className="fg-label">{copy.field}</span>
            <Textarea
              id={fieldId}
              rows={4}
              maxLength={ONBOARDING_REQUEST_MAX}
              placeholder={copy.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="ask-for-designs-request"
            />
          </label>
          {refused ? (
            <p role="alert" className="m-0 text-12 text-red">
              {refused}
            </p>
          ) : null}
        </div>
      }
    />
  ) : null;

  return {
    ask,
    dialog,
    pending: join.isPending || (asking === null && spend.isPending),
    /** A refused join, shown beside the link; a refused start or re-analysis shows in the dialog. */
    error: refusalLine(join.error),
  };
}
