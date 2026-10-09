// REQ-34 BC-3, BC-18: a move its checklist refused opens that checklist's form, built from the same
// definition the kernel judged it by, each refusal shown on the field it names. The refusals are the
// ones the shared contract produces for the kernel (`checklistRefusals`), never written by hand, so a
// refusal that loses its path or its checklist turns this red.

import { ISSUE_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistFormOf, checklistRefusals, evaluateChecklist } from "@forge/contracts/checklists";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ChecklistDialog, type ChecklistPrompt, checklistFieldsOf, checklistPromptOf } from "./checklist-dialog";

const NO_REQUIREMENT = {
  gap: "The issue is not linked to a requirement.",
  fix: "Link it to the agreed requirement it delivers, then write its plan.",
};

/** The refusals the kernel answers for a draft linked to no requirement, as the contract builds them. */
const refusals = checklistRefusals(
  evaluateChecklist(ISSUE_READY_CHECKLIST, {
    given: {},
    record: {
      requirement: NO_REQUIREMENT,
      criteria: { value: "1 criterion, tracing BC-1 of REQ-1 revision 1" },
      design: { value: "None: it builds no workflow design." },
    },
  }),
);

function Dialog({ prompt, onConfirm }: { prompt: ChecklistPrompt; onConfirm: (a: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <ChecklistDialog
      prompt={prompt}
      answers={answers}
      onAnswer={(q, v) => setAnswers((a) => ({ ...a, [q]: v }))}
      loading={false}
      onConfirm={onConfirm}
      onClose={() => undefined}
    />
  );
}

describe("the checklist form", () => {
  it("has one field per question of the definition, the refusal on the field its path names", () => {
    expect(refusals).toHaveLength(1);
    const prompt = checklistPromptOf(refusals);
    if (!prompt) throw new Error("a refusal naming a checklist opened no prompt");
    expect(prompt.checklist).toBe("issue_ready");
    const read = checklistFieldsOf(prompt);
    expect(read?.fields.map((f) => f.name)).toEqual(checklistFormOf(ISSUE_READY_CHECKLIST).fields.map((f) => f.name));
    expect(read?.fields.find((f) => f.name === "requirement")?.error).toBe(
      `Which agreed requirement does this issue deliver, and at which revision? ${NO_REQUIREMENT.gap} ${NO_REQUIREMENT.fix}`,
    );
    expect(read?.fields.filter((f) => f.error !== null)).toHaveLength(1);
  });

  it("shows the refusal on its field, and sends what the mover typed as the move's answers", async () => {
    const onConfirm = vi.fn();
    const prompt = checklistPromptOf(refusals);
    if (!prompt) throw new Error("no prompt");
    renderWithQuery(<Dialog prompt={prompt} onConfirm={onConfirm} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(refusals[0]?.detail);
    // shown inside its own field, not above the form as a refusal no field claims
    expect(alert.parentElement?.querySelectorAll("label")).toHaveLength(1);
    expect(alert.parentElement?.querySelector("label")?.textContent).toBe(
      "Which agreed requirement does this issue deliver, and at which revision?",
    );
    expect(screen.getByText(/Left blank, it is assumed: Not a hotfix/)).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Fixes FB-3");
    await user.click(screen.getByRole("button", { name: "Answer and move" }));
    expect(onConfirm).toHaveBeenCalledWith({ hotfix: "Fixes FB-3" });
  });

  it("reads in plain words: no field key in a hint, and an introduction that says what to do", () => {
    const prompt = checklistPromptOf(refusals);
    if (!prompt) throw new Error("no prompt");
    renderWithQuery(<Dialog prompt={prompt} onConfirm={() => undefined} />);
    const text = document.body.textContent ?? "";
    for (const key of ["requirementId", "acceptanceCriteria", "buildsWorkflow"]) expect(text).not.toContain(key);
    expect(screen.getByText("Answered on the issue itself, from its acceptance criteria.")).toBeTruthy();
    expect(screen.getByText("Answered on the issue itself, from its workflow design.")).toBeTruthy();
    expect(
      screen.getByText(
        "This issue cannot move yet. Each thing stopping it is shown in red under its question: fix those on the issue itself. Answer the questions you can here, then press Answer and move.",
      ),
    ).toBeTruthy();
  });

  it("is not opened for a refusal that names no checklist", () => {
    expect(checklistPromptOf([{ code: "NO_HOLDER", path: "/status", detail: "x" }])).toBeNull();
  });
});
