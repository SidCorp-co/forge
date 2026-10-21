// "Your feedback to Forge" (REQ-47 BC-3, BC-9): every item the signed-in person reported about Forge,
// from any project, with where it stands. The person need not be a member of Forge's home project;
// core answers only their own items.

import { useState } from "react";
import { EmptyState, enumLabel, ErrorState, ListPage, LoadingState, RowItem, RowList, StatusBadge } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useMyForgeFeedback } from "../hooks";
import type { ForgeFeedbackItem } from "../types";

type Copy = ReturnType<typeof useCopy>;
type Time = ReturnType<typeof useTimeFormat>;

/** Where one item stands, as short facts: its kind, where it came from, its reports and its forecast. */
function standingOf(item: ForgeFeedbackItem, t: Copy, language: string, time: Time) {
  const origin = item.origin;
  const eta = item.progress.eta;
  return [
    enumLabel("feedbackKind", item.kind, language),
    ...(origin?.project ? [t("feedback.row.from", { project: origin.project.name })] : []),
    ...(origin && origin.occurrences > 1 ? [t("feedback.row.reports", { n: origin.occurrences })] : []),
    ...(item.progress.running ? [t("feedback.forge.running")] : []),
    ...(eta.estimate ? [t("feedback.forge.likelyBy", { date: time.date(eta.likelyBy) })] : []),
    t("feedback.forge.sent", { age: time.age(item.createdAt) }),
  ];
}

export function MyForgeFeedback() {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const q = useMyForgeFeedback();
  const [open, setOpen] = useState<string | null>(null);
  const items = q.data?.feedback ?? [];
  return (
    <ListPage title={t("feedback.forge.mine")} testId="my-forge-feedback">
      {q.isPending ? (
        <LoadingState label={t("feedback.forge.mine")} rows={4} />
      ) : q.error ? (
        <ErrorState title={t("feedback.forge.unreadable")} message={formatApiError(q.error)} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState message={t("feedback.forge.empty")} />
      ) : (
        <RowList label={t("feedback.forge.mine")} pageGutter>
          {items.map((item) => (
            <RowItem
              key={item.key}
              rowKey={item.key}
              lead={item.key}
              title={item.title}
              facts={standingOf(item, t, language, time)}
              trailing={<StatusBadge family="feedbackPhase" value={item.phase} />}
              onClick={() => setOpen(open === item.key ? null : item.key)}
              expanded={open === item.key}
              testId="my-forge-feedback-item"
            >
              {open === item.key ? <p className="text-13 text-muted">{item.progress.says}</p> : null}
            </RowItem>
          ))}
        </RowList>
      )}
    </ListPage>
  );
}
