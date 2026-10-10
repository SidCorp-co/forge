"use client";

import type { QueryKey } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { AcceptStep, Button } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useSuggestionDecision } from "../hooks";
import type { SuggestionView } from "../types";
import { RejectStep } from "./reject-step";

/**
 * The two acts every waiting suggestion offers: Accept, through the confirm step that says what it
 * writes and takes the reason, and Reject, which requires one. `children` are further acts beside them.
 */
export function SuggestionDecider({
  projectId,
  s,
  affected,
  consequence,
  children,
}: {
  projectId: string;
  s: SuggestionView;
  /** What accepting it changes, read again once it is decided. */
  affected: readonly QueryKey[];
  /** What confirming the accept writes, said before it is pressed. */
  consequence: string;
  children?: ReactNode;
}) {
  const t = useCopy();
  const decide = useSuggestionDecision(projectId, affected);
  const [step, setStep] = useState<"accept" | "reject" | null>(null);
  const busy = decide.isPending;
  const closed = { onSuccess: () => setStep(null) };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="suggestion-decider">
      {/* while a step is open its openers are off: a second press would close it and drop the typed reason */}
      <Button type="button" size="sm" disabled={busy || step !== null} onClick={() => setStep("accept")} aria-expanded={step === "accept"}>
        {t("requirements.act.accept")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy || step !== null} onClick={() => setStep("reject")} aria-expanded={step === "reject"}>
        {t("requirements.act.reject")}
      </Button>
      {children}
      {step === "accept" ? (
        <div className="basis-full">
          <AcceptStep
            confirmLabel={t("requirements.act.accept")}
            consequence={consequence}
            loading={busy}
            onCancel={() => setStep(null)}
            onConfirm={(why) => decide.mutate({ kind: "accept", id: s.id, reason: why }, closed)}
          />
        </div>
      ) : null}
      {step === "reject" ? (
        <div className="basis-full">
          <RejectStep loading={busy} onCancel={() => setStep(null)} onConfirm={(why) => decide.mutate({ kind: "reject", id: s.id, reason: why }, closed)} />
        </div>
      ) : null}
      {decide.error ? (
        <div className="basis-full">
          <RefusalLine error={decide.error} />
        </div>
      ) : null}
    </div>
  );
}
