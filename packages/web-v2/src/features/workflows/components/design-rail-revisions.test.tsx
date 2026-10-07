// R-22, R-23, R-24: the design rail reads each linked requirement by the state its own page shows,
// marks a pin below the approved revision, and says which revision each build was linked against.

import { say, sentence } from "@/test/said";
import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { WorkflowDesign } from "../types";
import { WorkflowDesignFacts } from "./workflow-design-facts";

const OPEN = say("designs.gate.open", { r: "2" });
const design = {
  gate: { open: true, rule: sentence(OPEN), says: { rule: OPEN } },
  approvedRevision: 7,
  revisions: [],
  approver: "workflow-designs.approve",
  requirements: [
    { key: "REQ-25", title: "Checkout", status: "agreed", state: "in_delivery", pinnedRevision: 6 },
    { key: "REQ-26", title: "Refunds", status: "agreed", state: "agreed", pinnedRevision: 7 },
  ],
  builds: [
    { issueId: "i1", displayId: "ISS-1", title: "Old build", status: "closed", builtAgainst: 6 },
    { issueId: "i2", displayId: "ISS-2", title: "New build", status: "open", builtAgainst: 7 },
    { issueId: "i3", displayId: "ISS-3", title: "Unapproved link", status: "draft", builtAgainst: null },
  ],
} as unknown as WorkflowDesign;

function rail() {
  render(
    <WorkflowDesignFacts
      d={design}
      record={{ writerName: "Ba", document: { updatedAt: "2026-10-01T00:00:00Z" } } as never}
      shown={{ steps: [], kind: "flow", summary: null } as never}
      shownRevision={7}
      template={null}
      slug="epod"
      health={undefined as unknown as WorkflowHealth}
    />,
  );
}

describe("the design rail's revisions", () => {
  it("badges a linked requirement by its derived state, not its stored status (R-23)", () => {
    rail();
    const [first] = screen.getAllByTestId("rail-requirement");
    expect(first).toHaveTextContent("In delivery");
  });

  it("marks a pin below the approved revision and leaves a current one plain (R-24)", () => {
    rail();
    const pins = screen.getAllByTestId("rail-requirement-pin");
    expect(pins.map((p) => [p.textContent, p.getAttribute("data-lags")])).toEqual([
      ["r6", "true"],
      ["r7", "false"],
    ]);
    expect(pins[0]).toHaveAttribute("title", "REQ-25's agreed baseline pins revision 6, and revision 7 is approved now");
  });

  it("says which revision each build was linked against, marking one behind (R-22)", async () => {
    rail();
    await userEvent.click(screen.getByTestId("design-technical-toggle"));
    const builds = screen.getAllByTestId("rail-build");
    expect(within(builds[0] as HTMLElement).getByTestId("rail-build-revision")).toHaveAttribute("data-behind", "true");
    expect(within(builds[1] as HTMLElement).getByTestId("rail-build-revision")).toHaveTextContent("r7");
    expect(within(builds[2] as HTMLElement).queryByTestId("rail-build-revision")).toBeNull();
  });
});
