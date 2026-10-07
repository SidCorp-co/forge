// R-25: the workflows list says whom each design waits on, read off core's list reading.

import { RULE, say, waitingOn } from "@/test/said";
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
        r={record(waitingOn("person", { who: say("standing.who.holderOf", { perm: "workflow-designs.approve" }), act: say("designs.act.approveOrReturn", { r: 3 }), rule: RULE }))}
      />,
    );
    const cell = screen.getByTestId("waiting-on");
    expect(cell).toHaveAttribute("data-kind", "person");
    expect(cell).toHaveTextContent("A holder of workflow-designs.approve · approve or return revision 3");
  });

  it("says nothing for a design nobody owes a step on", () => {
    const { container } = render(
      <DesignWaits r={record(waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }))} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
