// The project's Lessons page (REQ-50): the confusions waiting on a person first, since each holds a
// lesson out of every prompt; then the lessons the steward proposed from corrections, the lessons in
// use with their provenance and applications, the corrections not yet grouped, the closed ones on a
// click, and the monthly read.

import type { LessonView } from "@forge/contracts/lessons";
import { useState } from "react";
import { Button, ReportPage, RowList, Section, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useLessons } from "../hooks";
import { ConfusionItem } from "./confusion-item";
import { CorrectionList } from "./correction-list";
import { LessonItem } from "./lesson-item";
import { LessonMonth } from "./lesson-month";

function Count({ n }: { n: number }) {
  return <span className="text-13 tabular-nums text-muted">{n}</span>;
}

function LessonGroup({ projectId, lessons, label, none, testId }: { projectId: string; lessons: LessonView[]; label: string; none: string; testId: string }) {
  return (
    <Section title={label} right={<Count n={lessons.length} />} testId={testId}>
      {lessons.length === 0 ? (
        <p className="py-2 text-13 text-muted">{none}</p>
      ) : (
        <RowList label={label}>
          {lessons.map((l) => (
            <LessonItem key={l.id} projectId={projectId} lesson={l} />
          ))}
        </RowList>
      )}
    </Section>
  );
}

function Closed({ projectId, lessons }: { projectId: string; lessons: LessonView[] }) {
  const t = useCopy();
  const [shown, setShown] = useState(false);
  if (lessons.length === 0) return null;
  return (
    <Section title={t("lessons.closed")} testId="lessons-closed">
      <Button type="button" size="sm" variant="ghost" onClick={() => setShown(!shown)} aria-expanded={shown}>
        {shown ? t("lessons.closedHide") : t("lessons.closedShow", { count: lessons.length })}
      </Button>
      {shown ? (
        <RowList label={t("lessons.closed")} className="mt-2">
          {lessons.map((l) => (
            <LessonItem key={l.id} projectId={projectId} lesson={l} />
          ))}
        </RowList>
      ) : null}
    </Section>
  );
}

function Body({ projectId }: { projectId: string }) {
  const t = useCopy();
  const q = useLessons(projectId);
  if (q.isError) {
    return (
      <p className="text-13 text-danger" role="alert">
        {formatApiError(q.error)}
      </p>
    );
  }
  if (!q.data) return <Skeleton className="h-40 w-full" />;
  const { lessons, corrections, confusions, canDecide } = q.data;
  const sentenceOf = (key: string) => lessons.find((l) => l.key === key)?.sentence ?? "";
  const of = (...statuses: LessonView["status"][]) => lessons.filter((l) => statuses.includes(l.status));
  return (
    <>
      <Section title={t("lessons.confusions")} right={<Count n={confusions.length} />} testId="lessons-confusions">
        {confusions.length === 0 ? (
          <p className="py-2 text-13 text-muted">{t("lessons.confusionsNone")}</p>
        ) : (
          <>
            <p className="mb-2 text-13 text-muted">{t("lessons.confusionsLead")}</p>
            <RowList label={t("lessons.confusions")}>
              {confusions.map((c) => (
                <ConfusionItem key={c.id} projectId={projectId} confusion={c} canDecide={canDecide} sentence={sentenceOf(c.lessonKey)} />
              ))}
            </RowList>
          </>
        )}
      </Section>
      <LessonGroup projectId={projectId} lessons={of("proposed")} label={t("lessons.proposed")} none={t("lessons.proposedNone")} testId="lessons-proposed" />
      <LessonGroup projectId={projectId} lessons={of("approved", "held")} label={t("lessons.approved")} none={t("lessons.approvedNone")} testId="lessons-approved" />
      <Section title={t("lessons.corrections")} right={<Count n={corrections.length} />} testId="lessons-corrections">
        <CorrectionList projectId={projectId} corrections={corrections} />
      </Section>
      <Closed projectId={projectId} lessons={of("rejected", "retired")} />
    </>
  );
}

export function LessonsPage({ projectId, now }: { projectId: string; now?: Date }) {
  const t = useCopy();
  return (
    <ReportPage title={t("lessons.title")} testId="lessons-page">
      <div className="grid max-w-4xl grid-cols-1 gap-2">
        <Body projectId={projectId} />
        <LessonMonth projectId={projectId} {...(now ? { now } : {})} />
      </div>
    </ReportPage>
  );
}
