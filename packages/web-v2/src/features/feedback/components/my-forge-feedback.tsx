// "Your feedback to Forge" (REQ-47 BC-3, BC-9): every item the signed-in person reported about Forge,
// from any project, with where it stands and what its triage told them (BC-10). The person need not be
// a member of Forge's home project; core answers only their own items.

import { useState } from "react";
import {
  EmptyState,
  enumLabel,
  ErrorState,
  ListPage,
  LoadingState,
  Property,
  PropertyList,
  RowItem,
  RowList,
  StatusBadge,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useMyForgeFeedback } from "../hooks";
import type { ForgeFeedbackItem } from "../types";

type Copy = ReturnType<typeof useCopy>;
type Time = ReturnType<typeof useTimeFormat>;

/**
 * Where one item stands, as short facts: where it came from, its reports, whether work runs, its forecast
 * and its age. Its kind and when it was sent open with the row (ISS-1131), and its key is the title's hover.
 */
function standingOf(item: ForgeFeedbackItem, t: Copy, time: Time) {
  const origin = item.origin;
  const eta = item.progress.eta;
  return [
    ...(origin?.project ? [origin.project.name] : []),
    ...(origin && origin.occurrences > 1 ? [t("feedback.row.reports", { n: origin.occurrences })] : []),
    ...(item.progress.running ? [t("feedback.forge.running")] : []),
    ...(eta.estimate ? [t("feedback.forge.likelyBy", { date: time.date(eta.likelyBy) })] : []),
    <span key="age" title={t("feedback.forge.sent", { age: time.age(item.createdAt) })}>
      {time.age(item.createdAt)}
    </span>,
  ];
}

/** What triage told the person about one item, as labelled rows; none where it told nothing yet. */
function Told({ item, t }: { item: ForgeFeedbackItem; t: Copy }) {
  const { answer, declined, clarification, shippedIn } = item.told;
  const rows = [
    { key: "answer", label: t("feedback.forge.told.answer"), value: answer },
    { key: "declined", label: t("feedback.forge.told.declined"), value: declined },
    { key: "asked", label: t("feedback.forge.told.asked"), value: clarification?.prompt ?? null },
    { key: "shippedIn", label: t("feedback.forge.told.shippedIn"), value: shippedIn },
  ].filter((r) => r.value);
  if (rows.length === 0) return null;
  return (
    <PropertyList testId="my-forge-feedback-told">
      {rows.map((r) => (
        <Property key={r.key} label={r.label} testId={`my-forge-feedback-told-${r.key}`}>
          <span className="whitespace-pre-wrap">{r.value}</span>
        </Property>
      ))}
    </PropertyList>
  );
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
              title={<span title={item.key}>{item.title}</span>}
              facts={standingOf(item, t, time)}
              trailing={<StatusBadge family="feedbackPhase" value={item.phase} />}
              onClick={() => setOpen(open === item.key ? null : item.key)}
              expanded={open === item.key}
              testId="my-forge-feedback-item"
            >
              {open === item.key ? (
                <>
                  <p className="text-13 text-muted">
                    {[enumLabel("feedbackKind", item.kind, language), item.origin?.project ? t("feedback.row.from", { project: item.origin.project.name }) : null, t("feedback.forge.sent", { age: time.age(item.createdAt) })]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-13 text-muted">{item.progress.says}</p>
                  <Told item={item} t={t} />
                </>
              ) : null}
            </RowItem>
          ))}
        </RowList>
      )}
    </ListPage>
  );
}
