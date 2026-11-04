
// What is true of an issue right now, in two lines and a stepper: Now and Done by. The words are the
// standing's own (core's `waitingOn`) and the forecast's, so the page writes no sentence of its own
// here. No line asks the reader to act: a person never works an issue, and what one owes a person is
// asked as a decision on its item, in Needs you (REQ-68 BC-4, BC-6; ISS-687).

import type { Forecast } from "@forge/contracts/forecast";
import type { IssueStanding } from "@forge/contracts/issue-standing";
import type { ReactNode } from "react";
import { EtaInline } from "@/features/forecast";
import { etaOfForecast } from "@/features/forecast";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { saidView } from "@/lib/i18n/said";
import { IssueSteps } from "../issue-standing-bits";

function Line({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-testid={testId}>
      <span className="w-21 flex-none text-12 font-medium uppercase tracking-wide text-subtle">{label}</span>
      <span className="min-w-0 text-14">{children}</span>
    </div>
  );
}

export function IssueStateHead({
  standing,
  forecast,
  panels,
}: {
  standing: IssueStanding;
  forecast: Forecast | undefined;
  /** What the page draws under Now: the patterns, and in the developer's view the open questions. */
  panels?: ReactNode;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const clock = useEtaClock();
  const w = saidView(standing.waitingOn, language);
  const done = standing.attentionGroup === "done";
  const eta = forecast && forecast.kind !== "landed" && forecast.kind !== "ended" ? etaOfForecast(forecast, clock) : null;
  return (
    <div className="grid gap-1.5 border-b border-line-subtle pb-4" data-testid="issue-state-head">
      <Line label={t("issues.now.now")} testId="issue-now">
        {done ? t("issues.attention.done") : [w.who, w.act].filter(Boolean).join(" · ")}
      </Line>
      {panels}
      {done ? null : (
        <Line label={t("issues.now.doneBy")} testId="issue-done-by">
          {eta ? <EtaInline eta={eta} clock={clock} /> : <span className="text-muted">{t("issues.now.unknown")}</span>}
        </Line>
      )}
      <div className="pt-3">
        {/* the bar shows where the work stands; Now says it in words, so the bar names no step (REQ-43 BC-5) */}
        <IssueSteps standing={standing} caption={false} named={false} />
      </div>
    </div>
  );
}
