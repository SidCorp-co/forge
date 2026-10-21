// One confusion waiting on a person (REQ-50 BC-5): what the lesson says, what stands against it, and
// the agent's recommendation marked on its own answer. The lesson is held until one is chosen: keep
// it, edit it (the recommended sentence filled in), or retire it.

import type { ConfusionView, LessonResolution } from "@forge/contracts/lessons";
import { useState } from "react";
import { Button, RowItem } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { useConfusionDecision } from "../hooks";
import { confusionWords, personWords } from "../words";
import { SentenceEditor } from "./sentence-editor";

const ANSWERS: readonly LessonResolution[] = ["keep", "edit", "retire"];

function Sides({ confusion }: { confusion: ConfusionView }) {
  const t = useCopy();
  const against = confusion.other.lessonKey
    ? `${t("lessons.confusion.otherLesson", { key: confusion.other.lessonKey })}: `
    : confusion.other.ref
      ? `${confusion.other.ref}: `
      : "";
  return (
    <dl className="grid grid-cols-1 gap-1 text-13">
      <dt className="text-12 font-semibold text-muted">{t("lessons.confusion.says")}</dt>
      <dd className="mb-1 text-fg">{confusion.sides.lesson}</dd>
      <dt className="text-12 font-semibold text-muted">{t("lessons.confusion.other")}</dt>
      <dd className="text-fg">
        {against}
        {confusion.sides.other}
      </dd>
    </dl>
  );
}

export function ConfusionItem({ projectId, confusion, canDecide, sentence }: { projectId: string; confusion: ConfusionView; canDecide: boolean; sentence: string }) {
  const t = useCopy();
  const [editing, setEditing] = useState(false);
  const decide = useConfusionDecision(projectId);
  const recommended = confusion.recommended.resolution;
  const choose = (resolution: LessonResolution) =>
    resolution === "edit" ? setEditing(true) : decide.mutate({ id: confusion.id, resolution });
  return (
    <RowItem
      testId="lesson-confusion"
      rowKey={confusion.id}
      lead={confusion.lessonKey}
      title={confusionWords(confusion.kind)}
      facts={[t("lessons.confusion.raisedBy", { name: personWords(t, confusion.raisedBy, confusion.raisedAgency), when: formatRelativeTime(confusion.raisedAt) })]}
      trailing={
        canDecide
          ? ANSWERS.map((r) => (
              <Button
                key={r}
                type="button"
                size="sm"
                variant={r === recommended ? "primary" : "secondary"}
                loading={decide.isPending && decide.variables?.resolution === r}
                onClick={() => choose(r)}
                data-testid={`confusion-${r}`}
                data-recommended={r === recommended || undefined}
              >
                {t(`lessons.act.${r}`)}
                {r === recommended ? ` · ${t("lessons.recommended")}` : ""}
              </Button>
            ))
          : null
      }
    >
      <div className="grid grid-cols-1 gap-2">
        <Sides confusion={confusion} />
        {!canDecide ? <p className="text-12 text-muted">{t("lessons.decideBy")}</p> : null}
        {editing ? (
          <SentenceEditor
            initial={confusion.recommended.sentence ?? sentence}
            label={t("lessons.act.save")}
            loading={decide.isPending}
            onCancel={() => setEditing(false)}
            onSave={(s) => decide.mutate({ id: confusion.id, resolution: "edit", sentence: s }, { onSuccess: () => setEditing(false) })}
          />
        ) : null}
        {decide.isError ? (
          <p className="text-12 text-danger" role="alert">
            {formatApiError(decide.error)}
          </p>
        ) : null}
      </div>
    </RowItem>
  );
}
