
import type { OnboardingHint } from "@forge/contracts/onboarding";
import { ONBOARDING_REQUEST_MAX } from "@forge/contracts/onboarding";
import { type ReactNode, useId, useState } from "react";
import { ConfirmDialog, Textarea } from "@/design";
import { useChatDock } from "@/features/chat-dock";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useJoinOnboarding, useReanalyze, useStartOnboarding } from "../hooks";

type Spend = "start" | "reanalyze";

// what each ask's confirm reads, by copy key
const COPY = {
  start: {
    title: "onboarding.ask.start.title",
    field: "onboarding.ask.start.field",
    placeholder: "onboarding.ask.start.placeholder",
    confirm: "onboarding.ask.start.confirm",
  },
  reanalyze: {
    title: "onboarding.ask.reanalyze.title",
    field: "onboarding.ask.reanalyze.field",
    placeholder: "onboarding.ask.reanalyze.placeholder",
    confirm: "onboarding.ask.reanalyze.confirm",
  },
} as const satisfies Record<Spend, Record<string, ProductCopyKey>>;

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
  const t = useCopy();
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
      title={t(copy.title)}
      confirmLabel={t(copy.confirm)}
      loading={spend.isPending}
      onConfirm={confirm}
      onClose={() => setAsking(null)}
      message={
        <div className="grid gap-3" data-testid="ask-for-designs">
          <p className="m-0 text-muted">{t("onboarding.ask.confirmCost")}</p>
          <label htmlFor={fieldId} className="grid gap-1.5">
            <span className="fg-label">{t(copy.field)}</span>
            <Textarea
              id={fieldId}
              rows={4}
              maxLength={ONBOARDING_REQUEST_MAX}
              placeholder={t(copy.placeholder)}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="ask-for-designs-request"
            />
          </label>
          {refused ? (
            <p role="alert" className="m-0 text-12 text-danger">
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
