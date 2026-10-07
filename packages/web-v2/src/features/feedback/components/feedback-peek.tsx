"use client";

// The peek (`?peek=FB-3`) beside the list: a summary, not the page — the header with the one
// primary act, whose turn it is, and the facts the full page's rail shows.

import { PeekHead, PeekPanel, type PeekState, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useEtaClock, useFeedbackForecasts } from "@/features/forecast/hooks";
import { useFeedbackItem } from "../hooks";
import { FeedbackPrimary } from "./feedback-detail";
import { FeedbackBanner, FeedbackFacts } from "./feedback-facts";

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
  const q = useFeedbackItem(projectId, fbKey);
  const forecasts = useFeedbackForecasts(projectId);
  const clock = useEtaClock(projectId);
  return (
    <PeekPanel peek={peek} listLabel="Feedback" noun="Feedback" onOpenFull={onOpenFull} testId="feedback-peek">
      <QueryBoundary query={q} loadingLabel="loading feedback…">
        {(data) => {
          const f = data.feedback;
          return (
            <>
              <PeekHead
                noun="Feedback"
                itemKey={f.key}
                badge={<StatusBadge family="feedbackPhase" value={f.phase} />}
                title={f.title}
                action={<FeedbackPrimary f={f} onAct={onOpenFull} />}
              />
              <FeedbackBanner f={f} className="px-[18px]" />
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
