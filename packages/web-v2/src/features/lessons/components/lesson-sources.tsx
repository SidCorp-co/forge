// What opens under a lesson (REQ-50 BC-4, BC-7): the corrections it learned from, each with who said
// it, where and when; and the outputs that applied it, each one a person can mark wrongly applied.

import type { ApplicationView, CorrectionView, LessonView } from "@forge/contracts/lessons";
import { useState } from "react";
import { Button } from "@/design";
import { RejectStep } from "@/features/suggestions";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { useMarkWronglyApplied } from "../hooks";
import { personWords, sourceWords } from "../words";

export function CorrectionLine({ correction }: { correction: CorrectionView }) {
  const t = useCopy();
  return (
    <li className="grid grid-cols-1 gap-0.5 border-b border-line-subtle py-2 last:border-b-0" data-testid="lesson-correction">
      <span className="text-13 text-fg">{correction.reason}</span>
      <span className="text-12 text-subtle">
        {sourceWords(correction.source)} · <span className="font-mono">{correction.item.key}</span>
        {correction.item.title ? ` ${correction.item.title}` : ""} ·{" "}
        {t("lessons.correction.by", { name: personWords(t, correction.by, correction.agency), when: formatRelativeTime(correction.at) })}
        {correction.score !== null ? ` · ${t("lessons.correction.score", { score: Math.round(correction.score * 100) })}` : ""}
      </span>
    </li>
  );
}

function Application({ projectId, application }: { projectId: string; application: ApplicationView }) {
  const t = useCopy();
  const [marking, setMarking] = useState(false);
  const mark = useMarkWronglyApplied(projectId);
  const outputKey = `lessons.output.${application.output.kind}` as const;
  return (
    <li className="grid grid-cols-1 gap-1 border-b border-line-subtle py-2 last:border-b-0" data-testid="lesson-application">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-13 text-fg">
          {t(outputKey)} <span className="font-mono text-12 text-subtle">{application.output.ref.slice(0, 8)}</span>
          <span className="text-12 text-subtle"> · {formatRelativeTime(application.at)}</span>
        </span>
        {application.wrong ? null : marking ? null : (
          <Button type="button" size="sm" variant="ghost" onClick={() => setMarking(true)} data-testid="lesson-wrong">
            {t("lessons.act.wrong")}
          </Button>
        )}
      </div>
      {application.wrong ? (
        <span className="text-12 text-danger">{t("lessons.application.wrong", { reason: application.wrong.reason })}</span>
      ) : null}
      {marking ? (
        <RejectStep
          label={t("lessons.act.wrong")}
          reasonLabel={t("lessons.wrongWhy")}
          loading={mark.isPending}
          onCancel={() => setMarking(false)}
          onConfirm={(reason) => mark.mutate({ id: application.id, reason }, { onSuccess: () => setMarking(false) })}
        />
      ) : null}
      {mark.isError ? (
        <p className="text-12 text-danger" role="alert">
          {formatApiError(mark.error)}
        </p>
      ) : null}
    </li>
  );
}

/** The lesson's provenance and, once it is in use, where it was applied. */
export function LessonSources({ projectId, lesson }: { projectId: string; lesson: LessonView }) {
  const t = useCopy();
  const inUse = lesson.status === "approved" || lesson.status === "held" || lesson.status === "retired";
  return (
    <div className="grid grid-cols-1 gap-3 border-l-2 border-line-subtle pl-3" data-testid="lesson-sources">
      <div>
        <h3 className="text-12 font-semibold text-muted">{t("lessons.provenance")}</h3>
        <ul>
          {lesson.corrections.map((c) => (
            <CorrectionLine key={c.id} correction={c} />
          ))}
        </ul>
      </div>
      {inUse ? (
        <div>
          <h3 className="text-12 font-semibold text-muted">{t("lessons.applications")}</h3>
          {lesson.applications.length === 0 ? (
            <p className="py-2 text-13 text-muted">{t("lessons.applicationsNone")}</p>
          ) : (
            <ul>
              {lesson.applications.map((a) => (
                <Application key={a.id} projectId={projectId} application={a} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
