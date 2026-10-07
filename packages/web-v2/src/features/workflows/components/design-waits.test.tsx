// R-25: the workflows list says whom each design waits on, read off core's list reading.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkflowRecord } from "../types";
import { DesignWaits } from "./workflow-parts";

const record = (waitingOn: WorkflowRecord["design"]["waitingOn"]) =>
  ({ design: { shown: "proposed", pendingRevision: null, approvedRevision: null, status: "proposed", waitingOn } }) as unknown as WorkflowRecord;

describe("whom a design on the list waits on", () => {
  it("names the approver and the act of a proposed design", () => {
    render(
      <DesignWaits
        r={record({ kind: "person", who: "Project admin", act: "approve or return revision 3", rule: "", ref: null, dueAt: null })}
      />,
    );
    const cell = screen.getByTestId("waiting-on");
    expect(cell).toHaveAttribute("data-kind", "person");
    expect(cell).toHaveTextContent("Project admin · approve or return revision 3");
  });

  it("says nothing for a design nobody owes a step on", () => {
    const { container } = render(
      <DesignWaits r={record({ kind: "none", who: "Nobody", act: "", rule: "", ref: null, dueAt: null })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
