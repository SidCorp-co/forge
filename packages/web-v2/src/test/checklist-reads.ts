// Checklist reads as core serves them, built from the contract's own checklists, for page tests:
// a record reader's answers, the read of one checklist, and a move it judged.

import type { ChecklistMove, ChecklistRead } from "@forge/contracts/checklist-read";
import { type Checklist, type ChecklistAnswer, checklistFormOf, evaluateChecklist, type RecordAnswers } from "@forge/contracts/checklists";
import { within } from "@testing-library/react";

const AT = "2026-10-09T10:00:00.000Z";

/** A record reader's answers, as core's reader gives them: these values, and a gap on the rest. */
export function record(checklist: Checklist, values: Record<string, string>): RecordAnswers {
  return Object.fromEntries(
    checklist.questions
      .filter((q) => q.answeredBy.by === "record")
      .map((q) => [q.id, values[q.id] !== undefined ? { value: values[q.id] as string } : { gap: `It has none for ${q.id}.`, fix: "Write one." }]),
  );
}

export function readOf(checklist: Checklist, now: RecordAnswers | null, moves: ChecklistMove[] = []): ChecklistRead {
  return {
    id: checklist.id,
    version: checklist.version,
    gates: checklist.gates,
    design: checklist.design,
    form: checklistFormOf(checklist),
    input: {},
    now: now ? evaluateChecklist(checklist, { given: {}, record: now }) : null,
    moves,
  };
}

export const passed = (answers: ChecklistAnswer[], standing: ChecklistMove["standing"] = "passed"): ChecklistMove => ({
  at: AT,
  from: "draft",
  to: "agreed",
  gate: "requirement_ready",
  standing,
  checklist: standing === "passed" ? { id: "requirement_ready", version: 1 } : null,
  answers: standing === "passed" ? answers : null,
  refusals: null,
  actor: { type: "user", agency: "human", id: "u1" },
  source: "requirements",
  countsAsPassed: standing === "passed",
});

/** A question's words, as the contract's form gives them. */
export const label = (checklist: Checklist, question: string) => checklistFormOf(checklist).fields.find((f) => f.name === question)?.label as string;

/** A choice's label, as the contract's form gives it. */
export const optionLabel = (checklist: Checklist, question: string, value: string) =>
  checklistFormOf(checklist).fields.find((f) => f.name === question)?.options.find((o) => o.value === value)?.label as string;

/** One question's row in a drawn checklist. */
export const row = (section: HTMLElement, question: string) => within(section).getAllByTestId("checklist-row").find((r) => r.dataset.question === question) as HTMLElement;

