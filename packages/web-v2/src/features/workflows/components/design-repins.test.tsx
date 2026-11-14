// The HOP shape (2026-10-07/08): approving access at a new revision left six designs needing only their
// pin moved. A proposal that only moves its pins reads as such, with the proof nothing else changed,
// and the base's page clears every pin-only dependent with one act, naming what it will not take.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RepinPlan } from "../types";
import type { DesignWords } from "../decision-words";
import { blockedWords, leavesStaleWords } from "../decision-words";
import { PinOnlyReading, DesignRepins } from "./design-repins";
import { productCopy } from "@/lib/i18n/product-copy";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

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
    expect(screen.getByTestId("design-pin-only-proof")).toHaveTextContent("Differs from r4 only at /basedOn/0/revision");
  });

  it("is nothing for any other change", () => {
    const { container } = render(
      <>
        <PinOnlyReading change={{ pins: [{ workflow: "access", from: 12, to: 13 }], ...proof }} approvedRevision={4} />
        <PinOnlyReading change={null} approvedRevision={4} />
      </>,
    );
    expect(container.querySelectorAll("[data-testid=design-pin-only]")).toHaveLength(1);
  });
});

describe("the act that clears a base's pin-only dependents", () => {
  it("names every design it takes, and sends them in core's order at the revisions read", () => {
    state.plan = planOf(true);
    mutate.mockReset();
    render(<DesignRepins projectId="p" workflowId="w-access" slug="hop" />);
    const panel = screen.getByTestId("design-repins");
    expect(panel).toHaveTextContent("6 designs only need their pin moved → r13");
    expect(screen.getAllByTestId("repin-ready").map((r) => r.getAttribute("data-flow"))).toEqual(FLOWS);
    expect(within(screen.getAllByTestId("repin-ready")[1]).getByText("proposal r6 by hop master, approved as filed")).toBeTruthy();
    expect(screen.getByTestId("repin-refused")).toHaveTextContent("billing-ux has a pending change beyond its pins");
    fireEvent.click(screen.getByTestId("repin-act"));
    expect(mutate).toHaveBeenCalledWith({ revision: 13, designs: FLOWS.map((flow, i) => ({ workflowId: `w-${flow}`, revision: 4 + i })) });
  });

  it("is the person's act, and off for a viewer who may not approve", () => {
    state.plan = planOf(false);
    render(<DesignRepins projectId="p" workflowId="w-access" slug="hop" />);
    expect(screen.getByTestId("design-repins")).toHaveTextContent("6 designs only need their pin moved → r13");
    expect(screen.getByTestId("repin-act")).toHaveTextContent("Approve 6 pin-only changes");
    expect(screen.getByTestId("repin-act")).toBeDisabled();
  });

  it("is nothing for a base with no dependent to re-pin", () => {
    state.plan = { ...planOf(true), ready: [], refused: [] };
    const { container } = render(<DesignRepins projectId="p" workflowId="w-access" slug="hop" />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ISS-805 c2 (judged fail on 0.4.0-dev.671): Issue lifecycle's Person view read "issue-lifecycle r20 →
// r27" and "re-pinned by this act as r22". A person reads each design by its title, and no flow slug,
// revision number or fingerprint.
describe("the person's view of the re-pin act and its approval warnings", () => {
  const TITLES: Record<string, string> = { access: "Access", "complaint-intake": "Complaint intake", "billing-ux": "Billing screens" };
  const person: DesignWords = { view: "person", nameOf: (f) => TITLES[f] ?? `${f[0].toUpperCase()}${f.slice(1)}` };
  const leaks = (text: string | null) => {
    expect(text).not.toMatch(/\br\d+\b/);
    for (const flow of [...FLOWS, "access", "billing-ux"]) expect(text).not.toContain(flow);
    expect(text).not.toContain("aaaaaaaaaaaa");
  };

  it("names each design by its title, with no revision, pin move or proof", () => {
    state.plan = planOf(true);
    render(<DesignRepins projectId="p" workflowId="w-access" slug="hop" words={person} />);
    const panel = screen.getByTestId("design-repins");
    expect(panel).toHaveTextContent("6 designs only need to follow this approval");
    expect(within(screen.getAllByTestId("repin-ready")[1]).getByText("Complaint intake")).toBeTruthy();
    expect(within(screen.getAllByTestId("repin-ready")[1]).getByText("filed by hop master")).toBeTruthy();
    expect(screen.getByTestId("repin-refused")).toHaveTextContent("Billing screens has a pending change beyond its pins");
    leaks(panel.textContent);
  });

  it("reads a pin-only proposal by its bases' titles, with no proof line", () => {
    render(<PinOnlyReading change={{ pins: [{ workflow: "access", from: 12, to: 13 }], ...proof }} approvedRevision={4} words={person} />);
    expect(screen.getByTestId("design-pin-only")).toHaveTextContent("Pin-only change · follows the new approval of Access, nothing else");
    expect(screen.queryByTestId("design-pin-only-proof")).toBeNull();
    leaks(screen.getByTestId("design-pin-only").textContent);
  });

  it("words a blocked approval and the designs it leaves behind by title", () => {
    const t = productCopy("en");
    const blocked = blockedWords({ revision: 27, bases: [{ workflow: "access", revision: 12, state: "stale", approvedRevision: 13, designStatus: "approved" }] }, t, "en", person);
    expect(blocked).toBe("This builds on unapproved Access, approved again since: approve the base first.");
    leaks(blocked);
    const stale = leavesStaleWords(27, [{ workflowId: "w", flow: "billing-ux", revision: 3, basedOnRevision: 12 }], t, "en", person);
    expect(stale).toBe("Approving this leaves Billing screens on an old base.");
    leaks(stale);
    expect(leavesStaleWords(27, [{ workflowId: "w", flow: "billing-ux", revision: 3, basedOnRevision: 12 }], t, "en")).toContain("billing-ux r3");
  });
});
