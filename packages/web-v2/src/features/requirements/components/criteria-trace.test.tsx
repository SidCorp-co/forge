// A criterion traced by hand onto the steps of a linked design (lane 3): its held trace reads pressed,
// a pick writes the whole trace for that criterion and design at once, keeping the lines it already
// names, and a requirement with nothing linked, or done, offers no trace.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, PROJECT } from "@/test/requirement-progress";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { RequirementPage } from "./requirement-detail";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const steps = [
  { id: "pay", does: "Pays", after: [], node: { type: "TASK", label: "Pay" } },
  { id: "refund", does: "Refunds", after: ["pay"], node: { type: "TASK", label: "Refund" } },
];
const d = {
  ...reqDetail,
  status: "agreed",
  revisions: reqDetail.revisions.filter((r) => r.state === "current"),
  workflows: [reqDetail.workflows[0]],
  traces: [{ code: "BC-1", workflowId: "w1", flow: "thanh-toan", steps: ["pay"], edges: [{ from: "pay", to: "refund" }] }],
  standing: { ...reqDetail.standing, attentionGroup: "moving" },
} as RequirementDetail;

function show(detail: RequirementDetail) {
  const calls = fakeCore((c: Call) => {
    if (c.method === "PUT") return { body: detail };
    if (c.path === `/projects/${PROJECT}/workflows`) return { body: { workflows: [{ document: { id: "w1", flow: "thanh-toan", title: "Thanh toan", steps } }], returned: 1 } };
    return HANG;
  });
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="criteria" onTab={() => {}} />, client(detail));
  return calls;
}

describe("a criterion's trace onto a linked design", () => {
  it("reads the held trace pressed and writes the whole trace on a pick, its lines kept", async () => {
    const calls = show(d);
    fireEvent.click(within(screen.getByTestId("trace-design")).getByRole("button", { name: "Thanh toan" }));
    const first = (await screen.findAllByTestId("trace-criterion"))[0];
    expect(first).toHaveAttribute("data-code", "BC-1");
    expect(await within(first).findByRole("button", { name: "Pay" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(first).getByRole("button", { name: "Refund" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: `/projects/${PROJECT}/requirements/REQ-1/criteria/BC-1/steps`,
      body: { workflow: "thanh-toan", steps: ["pay", "refund"], edges: [{ from: "pay", to: "refund" }] },
    });
  });

  it("is not offered with no design linked", () => {
    show({ ...d, workflows: [] });
    expect(screen.queryByTestId("criteria-trace")).toBeNull();
  });

  it("is not offered on a requirement that is done", () => {
    show({ ...d, standing: { ...d.standing, attentionGroup: "done" } });
    expect(screen.queryByTestId("criteria-trace")).toBeNull();
  });
});
