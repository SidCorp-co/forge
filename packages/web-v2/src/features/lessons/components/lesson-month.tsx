// The monthly read (REQ-50 BC-8): corrections by source, lessons approved, repeats (a correction said
// again after its lesson was approved), and each confusion with its hours to a decision.

import { CORRECTION_SOURCES } from "@forge/contracts/lessons";
import { useState } from "react";
import { Button, Section, Skeleton, StatCell, StatRow } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useLessonsMonth } from "../hooks";
import { confusionWords, sourceWords } from "../words";

/** `YYYY-MM` of the month `offset` months from `now` (UTC, as core counts it). */
export function monthOf(now: Date, offset: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function Steps({ month, offset, setOffset }: { month: string; offset: number; setOffset: (n: number) => void }) {
  const t = useCopy();
  return (
    <>
      <Button type="button" size="sm" variant="ghost" icon="chevronLeft" aria-label={t("lessons.month.prev")} onClick={() => setOffset(offset - 1)} />
      <span className="font-mono text-13 tabular-nums" data-testid="lessons-month-label">
        {month}
      </span>
      <Button type="button" size="sm" variant="ghost" icon="chevronRight" aria-label={t("lessons.month.next")} disabled={offset >= 0} onClick={() => setOffset(offset + 1)} />
    </>
  );
}

export function LessonMonth({ projectId, now: given }: { projectId: string; now?: Date }) {
  const t = useCopy();
  const [now] = useState(() => given ?? new Date());
  const [offset, setOffset] = useState(0);
  const month = monthOf(now, offset);
  const q = useLessonsMonth(projectId, month);
  const read = q.data;
  const decided = read?.confusions.items.filter((c) => c.decidedAt) ?? [];
  const meanHours = decided.length ? Math.round((decided.reduce((s, c) => s + c.hours, 0) / decided.length) * 10) / 10 : null;
  return (
    <Section title={t("lessons.month")} right={<Steps month={month} offset={offset} setOffset={setOffset} />} testId="lessons-month">
      {read ? (
        <div className="grid grid-cols-1 gap-4">
          <StatRow cells={5} cellMin={120}>
            <StatCell label={t("lessons.month.corrections")} value={read.corrections.total} />
            <StatCell label={t("lessons.month.approved")} value={read.lessonsApproved} />
            <StatCell label={t("lessons.month.repeats")} value={read.repeats} hint={t("lessons.month.repeatsHint")} testId="lessons-month-repeats" />
            <StatCell label={t("lessons.month.raised")} value={read.confusions.raised} hint={`${t("lessons.month.open")}: ${read.confusions.open}`} />
            <StatCell label={t("lessons.month.decide")} value={meanHours ?? "–"} />
          </StatRow>
          <p className="text-12 text-subtle" data-testid="lessons-month-sources">
            {t("lessons.month.bySource")}:{" "}
            {CORRECTION_SOURCES.filter((s) => read.corrections.bySource[s] > 0)
              .map((s) => `${sourceWords(s)} ${read.corrections.bySource[s]}`)
              .join(" · ") || "–"}
          </p>
          {read.confusions.items.length > 0 ? (
            <ul className="grid gap-1 text-13">
              {read.confusions.items.map((c) => (
                <li key={c.id} className="font-mono text-12 text-muted">
                  {t(c.decidedAt ? "lessons.month.confusion" : "lessons.month.confusionOpen", { key: c.lessonKey, kind: confusionWords(c.kind), hours: c.hours })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : q.isError ? (
        <p className="text-13 text-danger" role="alert">
          {formatApiError(q.error)}
        </p>
      ) : (
        <Skeleton className="h-20 w-full" />
      )}
    </Section>
  );
}
