"use client";

// The checklists of one requirement or feedback item, each drawn by `ChecklistAnswers` from core's
// read. A gap points to where it is answered: a requirement's revision for a question its head
// revision answers, the triage form for a feedback item a person may triage.

import type { ChecklistRead } from "@forge/contracts/checklist-read";
import type { ChecklistFormField } from "@forge/contracts/checklists";
import type { ReactNode } from "react";
import { Button } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackChecklists, useRequirementChecklists } from "../hooks";
import { ChecklistAnswers } from "./checklist-answers";

/** Whether the question is answered by the requirement's head revision, which a new revision changes. */
const onRevision = (field: ChecklistFormField) => field.recordField?.startsWith("revision.") === true;

function Checklists({
  reads,
  revision,
  answerAt,
  testId,
  developer,
}: {
  reads: ChecklistRead[];
  revision: number | null;
  answerAt?: ((field: ChecklistFormField) => ReactNode) | undefined;
  testId: string;
  developer: boolean;
}) {
  return (
    <div className="grid gap-8" data-testid={testId}>
      {reads.map((read) => (
        <ChecklistAnswers key={read.id} read={read} revision={revision} answerAt={answerAt} developer={developer} />
      ))}
    </div>
  );
}

export function RequirementChecklists({
  projectId,
  reqKey,
  onRevise,
  developer = false,
}: {
  projectId: string;
  reqKey: string;
  onRevise?: (() => void) | undefined;
  developer?: boolean;
}) {
  const t = useCopy();
  const q = useRequirementChecklists(projectId, reqKey);
  if (q.error) return <RefusalLine error={q.error} testid="requirement-checklists-refusal" />;
  if (!q.data) return null;
  const answerAt = onRevise
    ? (field: ChecklistFormField) =>
        onRevision(field) ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRevise}>
            {t("checklist.answer")}
          </Button>
        ) : null
    : undefined;
  return <Checklists reads={q.data.checklists} revision={q.data.revision} answerAt={answerAt} testId="requirement-checklists" developer={developer} />;
}

export function FeedbackChecklists({ projectId, fbKey, canTriage, developer = false }: { projectId: string; fbKey: string; canTriage: boolean; developer?: boolean }) {
  const t = useCopy();
  const q = useFeedbackChecklists(projectId, fbKey);
  if (q.error) return <RefusalLine error={q.error} testid="feedback-checklists-refusal" />;
  if (!q.data) return null;
  const answerAt = canTriage
    ? () => (
        <a href="#feedback-act" className="text-13 font-medium text-link hover:underline">
          {t("checklist.answer")}
        </a>
      )
    : undefined;
  return <Checklists reads={q.data.checklists} revision={null} answerAt={answerAt} testId="feedback-checklists" developer={developer} />;
}
