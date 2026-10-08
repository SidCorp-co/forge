// REQ-34 BC-3, BC-18: a move its checklist refused opens that checklist's form, built from the same
// definition the kernel judged it by, each refusal shown on the field it names.

import { ISSUE_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistFormOf } from "@forge/contracts/checklists";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ChecklistDialog, checklistFieldsOf, checklistPromptOf } from "./checklist-dialog";

const refusals = [
  {
    code: "CHECKLIST_INCOMPLETE",
    path: "/answers/requirement",
    detail: "Which agreed requirement does this issue deliver, and at which revision? This issue names no requirement.",
    checklist: "issue_ready",
  },
];

describe("the checklist form", () => {
  it("has one field per question of the definition, the refusal on the field its path names", () => {
    const prompt = checklistPromptOf(refusals);
    if (!prompt) throw new Error("a refusal naming a checklist opened no prompt");
    expect(prompt.checklist).toBe("issue_ready");
    const read = checklistFieldsOf(prompt);
    expect(read?.fields.map((f) => f.name)).toEqual(checklistFormOf(ISSUE_READY_CHECKLIST).fields.map((f) => f.name));
    expect(read?.fields.find((f) => f.name === "requirement")?.error).toBe(refusals[0]?.detail);
    expect(read?.fields.filter((f) => f.error !== null)).toHaveLength(1);
  });

  it("shows the refusal on its field, and sends what the mover typed as the move's answers", async () => {
    const onConfirm = vi.fn();
    renderWithQuery(
      <ChecklistDialog
        prompt={{ checklist: "issue_ready", refusals }}
        loading={false}
        onConfirm={onConfirm}
        onClose={() => undefined}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(refusals[0]?.detail);
    expect(alert.parentElement?.querySelector("label")?.textContent).toBe(
      "Which agreed requirement does this issue deliver, and at which revision?",
    );
    expect(screen.getByText(/Left blank, it is assumed: Not a hotfix/)).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox"), "Fixes FB-3");
    await user.click(screen.getByRole("button", { name: "Answer and move" }));
    expect(onConfirm).toHaveBeenCalledWith({ hotfix: "Fixes FB-3" });
  });

  it("is not opened for a refusal that names no checklist", () => {
    expect(checklistPromptOf([{ code: "NO_HOLDER", path: "/status", detail: "x" }])).toBeNull();
  });
});
