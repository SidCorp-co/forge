"use client";

// The peek (`?peek=FB-3`) beside the list: a summary, not the page — the header with the one
// primary act, whose turn it is, and the facts the full page's rail shows.

import { Written } from "@/lib/i18n/written";
import { PeekHead, PeekPanel, type PeekState, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useFeedbackForecasts } from "@/features/forecast/hooks";
import { useFeedbackItem } from "../hooks";
import { FeedbackPrimary } from "./feedback-detail";
import { FeedbackBanner, FeedbackFacts } from "./feedback-facts";
import { TriageVerbs } from "./feedback-verbs";

export function FeedbackPeek({
  projectId,
  slug,
  fbKey,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  fbKey: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const t = useCopy();
  const q = useFeedbackItem(projectId, fbKey);
  const forecasts = useFeedbackForecasts(projectId);
  const clock = useEtaClock();
  return (
    <PeekPanel peek={peek} listLabel={t("feedback.title")} noun={t("feedback.title")} onOpenFull={onOpenFull} testId="feedback-peek">
      <QueryBoundary query={q} loadingLabel={t("feedback.loading")}>
        {(data) => {
          const f = data.feedback;
          return (
            <>
              <PeekHead
                noun={t("feedback.title")}
                itemKey={f.key}
                badge={<StatusBadge family="feedbackPhase" value={f.phase} />}
                title={<Written text={f.title} lang={f.writtenLang} />}
                action={<FeedbackPrimary f={f} onAct={onOpenFull} />}
              />
              <FeedbackBanner f={f} slug={slug} className="px-[18px]" />
              <div className="px-[18px] pt-3 empty:hidden">
                <TriageVerbs projectId={projectId} f={f} />
              </div>
              <div className="px-[18px] pb-4 pt-4">
                <FeedbackFacts f={f} slug={slug} forecast={forecasts.data?.items.find((i) => i.key === f.key)} clock={clock} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
