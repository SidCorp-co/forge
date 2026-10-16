
// The peek (`?peek=FB-3`) beside the list: a summary, not the page — the header with the one
// primary act, whose turn it is, its progress (is work running, and its estimate or why it has none,
// so the rail below says no date a second time), what the reporter said and showed, and the facts
// the full page's rail shows.

import { Written } from "@/lib/i18n/written";
import { PeekHead, PeekPanel, type FullPage, type PeekState, useOpenFullPage, StatusBadge } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackItem } from "../hooks";
import { FeedbackPrimary } from "./feedback-detail";
import { FeedbackBanner, LinkedFeedback } from "./feedback-facts";
import { FeedbackPeekSaid } from "./feedback-peek-said";
import { FeedbackProgress } from "./feedback-progress";
import { TriageVerbs } from "./feedback-verbs";

export function FeedbackPeek({
  projectId,
  slug,
  fbKey,
  peek,
  full,
}: {
  projectId: string;
  slug: string;
  fbKey: string;
  peek: PeekState;
  full: FullPage;
}) {
  const t = useCopy();
  const q = useFeedbackItem(projectId, fbKey);
  const openFull = useOpenFullPage(full);
  return (
    <PeekPanel peek={peek} listLabel={t("feedback.title")} noun={t("feedback.title")} full={full} testId="feedback-peek">
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
                action={<FeedbackPrimary f={f} onAct={openFull} />}
              />
              <FeedbackBanner f={f} slug={slug} className="px-4.5" />
              <FeedbackProgress projectId={projectId} slug={slug} fbKey={f.key} className="px-4.5 pt-3" />
              <div className="px-4.5 pt-3 empty:hidden">
                <TriageVerbs projectId={projectId} f={f} />
              </div>
              <div className="px-4.5 pb-4 pt-4">
                <FeedbackPeekSaid projectId={projectId} f={f} />
                <LinkedFeedback f={f} slug={slug} />
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </PeekPanel>
  );
}
