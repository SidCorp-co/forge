// The HOP shape (2026-10-07/08): approving access at a new revision left six designs needing only their
// pin moved. A proposal that only moves its pins reads as such, with the proof nothing else changed,
// and the base's page clears every pin-only dependent with one act, naming what it will not take.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import type { RepinPlan } from "../types";
import { PinOnlyReading, RepinPanel } from "./design-repins";

const mutate = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ plan: null as RepinPlan | null }));
vi.mock("../hooks", () => ({
  useRepinPlan: () => ({ data: state.plan }),
  useRepinAct: () => ({ mutate, isPending: false, isError: false, isSuccess: false, error: null, data: undefined }),
}));

const FLOWS = ["operational-case", "complaint-intake", "complaint-ux", "campaign-ux", "evaluation-ux", "loyalty-ux"];
const proof = { changed: ["/basedOn/0/revision"], fingerprint: "a".repeat(64) };

const planOf = (canDecide: boolean): RepinPlan => ({
  base: { workflowId: "w-access", flow: "access", approvedRevision: 13 },
  canDecide,
  ready: FLOWS.map((flow, i) => ({
    workflowId: `w-${flow}`,
    flow,
    revision: 4 + i,
    approvedRevision: 4,
    source: flow === "complaint-intake" ? "proposal" : "approved",
    approves: 5 + i,
    proposedByName: flow === "complaint-intake" ? "hop master" : null,
    pins: [{ workflow: "access", from: 12, to: 13 }],
    proof,
  })),
  refused: [
    {
      workflowId: "w-billing",
      flow: "billing-ux",
      revision: 3,
      refusal: { code: "WORKFLOW_REPIN_PENDING_CHANGE", path: "", detail: "core's words", flow: "billing-ux" },
    },
  ],
});

describe("a proposal that only moves its pins", () => {
  it("reads as a pin-only change, with the pins old → new and the proof nothing else changed", () => {
    render(<PinOnlyReading change={{ pins: [{ workflow: "access", from: 12, to: 13 }], ...proof }} approvedRevision={4} />);
    expect(screen.getByTestId("design-pin-only")).toHaveTextContent("Pin-only change · access r12 → r13, nothing else");
    expect(screen.getByTestId("design-pin-only-proof")).toHaveTextContent("Against approved r4 the design differs only at /basedOn/0/revision");
  });

  it("reads in Vietnamese, and is nothing for any other change", () => {
    const { container } = render(
      <InterfaceLanguageScope language="vi">
        <PinOnlyReading change={{ pins: [{ workflow: "access", from: 12, to: 13 }], ...proof }} approvedRevision={4} />
        <PinOnlyReading change={null} approvedRevision={4} />
      </InterfaceLanguageScope>,
    );
    expect(screen.getByTestId("design-pin-only")).toHaveTextContent("Chỉ đổi phiên bản ghim"); // i18n-allow: asserts the vi copy of the re-pin act
    expect(container.querySelectorAll("[data-testid=design-pin-only]")).toHaveLength(1);
  });
});

describe("the act that clears a base's pin-only dependents", () => {
  it("names every design it takes, and sends them in core's order at the revisions read", () => {
    state.plan = planOf(true);
    mutate.mockReset();
    render(<RepinPanel projectId="p" workflowId="w-access" slug="hop" />);
    const panel = screen.getByTestId("design-repins");
    expect(panel).toHaveTextContent("6 designs only need their pin moved → r13");
    expect(screen.getAllByTestId("repin-ready").map((r) => r.getAttribute("data-flow"))).toEqual(FLOWS);
    expect(within(screen.getAllByTestId("repin-ready")[1] as HTMLElement).getByText("proposal r6 by hop master, approved as filed")).toBeTruthy();
    expect(screen.getByTestId("repin-refused")).toHaveTextContent("billing-ux has a pending change beyond its pins");
    fireEvent.click(screen.getByTestId("repin-act"));
    expect(mutate).toHaveBeenCalledWith({ revision: 13, designs: FLOWS.map((flow, i) => ({ workflowId: `w-${flow}`, revision: 4 + i })) });
  });

  it("is the person's act in Vietnamese, and off for a viewer who may not approve", () => {
    state.plan = planOf(false);
    render(
      <InterfaceLanguageScope language="vi">
        <RepinPanel projectId="p" workflowId="w-access" slug="hop" />
      </InterfaceLanguageScope>,
    );
    expect(screen.getByTestId("design-repins")).toHaveTextContent("6 thiết kế chỉ cần đổi ghim → r13"); // i18n-allow: asserts the vi copy of the re-pin act
    expect(screen.getByTestId("repin-act")).toHaveTextContent("Duyệt 6 bản chỉ đổi ghim"); // i18n-allow: asserts the vi copy of the re-pin act
    expect(screen.getByTestId("repin-act")).toBeDisabled();
  });

  it("is nothing for a base with no dependent to re-pin", () => {
    state.plan = { ...planOf(true), ready: [], refused: [] };
    const { container } = render(<RepinPanel projectId="p" workflowId="w-access" slug="hop" />);
    expect(container).toBeEmptyDOMElement();
  });
});
