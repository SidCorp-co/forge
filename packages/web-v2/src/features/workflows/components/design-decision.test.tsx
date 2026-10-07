// An approval may carry its approver's note (ISS-259): the banner's note control sends it, the header's
// Approve stays one click without one, and each mode keeps its own draft.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
import type { useDesignDecision } from "../hooks";
import type { DesignDecisionBody } from "../types";
import { ApprovalReading, ApproveAction, DecisionError, DecisionNoteControl } from "./design-decision";

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

// A decision refusal reads in the viewer's language, worded from its code and facts; an Approve core
// already knows would be refused is off with the reason shown; approving a base names the designs it
// leaves stale before the click.
describe("what the approver reads before and after the click", () => {
  const block = {
    code: "WORKFLOW_DESIGN_BASE_UNAPPROVED" as const,
    revision: 7,
    bases: [{ workflow: "hop-access-decision", revision: 10, state: "stale" as const, approvedRevision: 11, designStatus: "approved" as const }],
    detail: 'revision 7 builds on "hop-access-decision" rev 10, which is no longer the approved revision',
  };
  const refusedWith = (refusal: Record<string, unknown>) =>
    ({
      mutate: vi.fn(),
      isPending: false,
      isError: true,
      error: new ApiError(422, "refused", "WORKFLOW_DESIGN_BASE_UNAPPROVED", undefined, { error: { code: refusal.code, message: "refused", refusals: [refusal] } }),
    }) as unknown as Decide;

  it("words a base refusal in Vietnamese from its facts, never core's English detail", () => {
    const vi = productCopy("vi");
    render(
      <InterfaceLanguageScope language="vi">
        <DecisionError decide={refusedWith({ ...block, path: "/revision" })} />
      </InterfaceLanguageScope>,
    );
    const line = screen.getByTestId("design-decision-error");
    expect(line).toHaveTextContent("WORKFLOW_DESIGN_BASE_UNAPPROVED");
    const base = vi("workflows.refusal.base.stale", { flow: "hop-access-decision", r: 10, approved: 11 });
    expect(line).toHaveTextContent(vi("workflows.refusal.baseUnapproved", { r: 7, bases: base }));
    expect(vi("workflows.refusal.baseUnapproved", { r: 7, bases: base })).not.toBe(productCopy("en")("workflows.refusal.baseUnapproved", { r: 7, bases: base }));
    expect(line).not.toHaveTextContent("builds on");
  });

  it("reads core's detail where the refusal carries no facts this screen words", () => {
    render(
      <InterfaceLanguageScope language="vi">
        <DecisionError decide={refusedWith({ code: "WORKFLOW_DESIGN_BASE_UNAPPROVED", path: "/revision", detail: "an older core's sentence" })} />
      </InterfaceLanguageScope>,
    );
    expect(screen.getByTestId("design-decision-error")).toHaveTextContent("an older core's sentence");
  });

  it("keeps Approve off, saying why, while core knows the base refuses it", () => {
    const { decide, mutate } = decider();
    render(<ApproveAction revision={7} decide={decide} block={block} />);
    const approve = screen.getByTestId("design-approve");
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(mutate).not.toHaveBeenCalled();
    render(<ApprovalReading revision={7} block={block} leavesStale={[]} />);
    expect(screen.getByTestId("design-approve-blocked")).toHaveTextContent("Rev 7 cannot be approved yet: it builds on hop-access-decision r10, which is approved at r11 now.");
    render(<DecisionNoteControl revision={7} decide={decide} approveBlocked />);
    expect(screen.queryByTestId("design-approve-note-open")).toBeNull();
    expect(screen.getByTestId("design-return-open")).toBeInTheDocument();
  });

  it("names the designs approving a base leaves on a stale base, before the click", () => {
    render(
      <ApprovalReading
        revision={11}
        block={null}
        leavesStale={[
          { workflowId: "w1", flow: "operational-case", revision: 7, basedOnRevision: 10 },
          { workflowId: "w2", flow: "complaint-intake", revision: 1, basedOnRevision: 10 },
          { workflowId: "w3", flow: "complaint-ux", revision: 1, basedOnRevision: 10 },
        ]}
      />,
    );
    expect(screen.getByTestId("design-leaves-stale")).toHaveTextContent("Approving r11 leaves operational-case r7, complaint-intake r1 and complaint-ux r1 on a stale base.");
    expect(screen.queryByTestId("design-approve-blocked")).toBeNull();
  });

  it("shows nothing when approving strands nothing and nothing refuses it", () => {
    const { container } = render(<ApprovalReading revision={11} block={null} leavesStale={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
