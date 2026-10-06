// An approval may carry its approver's note (ISS-259): the banner's note control sends it, the header's
// Approve stays one click without one, and each mode keeps its own draft.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { useDesignDecision } from "../hooks";
import type { DesignDecisionBody } from "../types";
import { ApproveAction, DecisionNoteControl } from "./design-decision";

type Decide = ReturnType<typeof useDesignDecision>;

const decider = () => {
  const mutate = vi.fn<(body: DesignDecisionBody) => void>();
  return { decide: { mutate, isPending: false, isError: false, error: null } as unknown as Decide, mutate };
};

const box = (testid: string) => screen.getByTestId(testid).querySelector("textarea") as HTMLTextAreaElement;

describe("deciding a design with a note", () => {
  it("approves the waiting revision with the typed note, trimmed", () => {
    const { decide, mutate } = decider();
    render(<DecisionNoteControl revision={4} decide={decide} />);
    fireEvent.click(screen.getByTestId("design-approve-note-open"));
    expect(screen.getByLabelText("Conditions of this approval")).toBeInTheDocument();
    expect(screen.getByTestId("design-approve-note-submit")).toBeDisabled();
    fireEvent.change(box("design-approve-note"), { target: { value: "  The SLA step is owed in rev 5.  " } });
    fireEvent.click(screen.getByTestId("design-approve-note-submit"));
    expect(mutate).toHaveBeenCalledWith({ revision: 4, decision: "approve", reason: "The SLA step is owed in rev 5." });
  });

  it("keeps the header's Approve one click, with no note", () => {
    const { decide, mutate } = decider();
    render(<ApproveAction revision={4} decide={decide} />);
    fireEvent.click(screen.getByTestId("design-approve"));
    expect(mutate).toHaveBeenCalledWith({ revision: 4, decision: "approve" });
  });

  it("never carries a cancelled draft from one mode into the other", () => {
    const { decide, mutate } = decider();
    render(<DecisionNoteControl revision={4} decide={decide} />);
    fireEvent.click(screen.getByTestId("design-return-open"));
    fireEvent.change(box("design-return"), { target: { value: "Name the consent owner." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("design-approve-note-open"));
    expect(box("design-approve-note").value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByTestId("design-return-open"));
    expect(box("design-return").value).toBe("Name the consent owner.");
    fireEvent.click(screen.getByTestId("design-return-submit"));
    expect(mutate).toHaveBeenCalledWith({ revision: 4, decision: "return", reason: "Name the consent owner." });
  });
});
