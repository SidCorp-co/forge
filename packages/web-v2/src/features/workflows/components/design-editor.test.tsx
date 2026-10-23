// A design written in place from its Edit view (lane 3): what a save does is said before it is pressed
// — a draft stays a draft and is proposed by its own act, any other design goes to its approver by the
// save — and the save sends the whole document over the revision it was read at. A refusal core names
// at a step or line opens that step or line and is drawn in it.

import { BUILTIN_WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import type { DesignStatus, WorkflowDesign, WorkflowRecord } from "../types";
import { DesignEditor } from "./design-editor";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const AT = "2026-10-07T10:00:00.000Z";
const TEMPLATE = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "state-machine") as WorkflowTemplate;
const document = {
  $schema: "https://forge.sidcorp.co/schemas/workflow-v2.json",
  version: 2,
  project: "p-1",
  flow: "case",
  kind: "state",
  title: "Follow-up case",
  summary: "A case opens and closes.",
  template: { id: "state-machine", version: 1 },
  steps: [
    { id: "start", does: "The machine starts.", after: [], node: { type: "INITIAL" } },
    { id: "open", does: "The case waits.", after: ["start"], node: { type: "STATE", label: "Open", mapsTo: "requested" } },
  ],
  edges: [{ from: "start", to: "open", label: "case.opened" }],
  writtenBy: {},
  id: "w-1",
  createdAt: AT,
  updatedAt: AT,
};
const record = { revision: 3, writer: "u-1", writerName: "Ana", document } as unknown as WorkflowRecord;
const design = (status: DesignStatus) =>
  ({ workflowId: "w-1", flow: "case", status, revision: 3, proposedRevision: null, approvedRevision: status === "approved" ? 3 : null, canDecide: false, waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }), revisions: [], builds: [] }) as unknown as WorkflowDesign;

function show(status: DesignStatus, reply: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const calls = fakeCore((c) => (c.method === "GET" ? HANG : reply(c)));
  renderWithQuery(<DesignEditor projectId="p-1" slug="hop" d={design(status)} record={record} template={TEMPLATE} />);
  return { calls, editor: screen.getByTestId("design-editor") };
}

const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("a draft design", () => {
  it("says a save keeps it a draft, saves the whole document over the revision read, and keeps what it did not edit", async () => {
    const { calls, editor } = show("draft");
    expect(within(editor).getByTestId("design-edit-standing")).toHaveTextContent("A save keeps it a draft");
    const save = within(editor).getByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();
    typeInto(within(editor).getByRole("textbox", { name: /^Title/ }), "Follow-up case (clinic)");
    expect(within(editor).getByTestId("design-edit-standing")).toHaveTextContent("Unsaved changes");
    fireEvent.click(within(editor).getByRole("button", { name: "Add step" }));
    fireEvent.click(save);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT") as Call;
    expect(put.path).toBe("/projects/p-1/workflows/w-1");
    const body = put.body as { baseRevision: number; document: Record<string, unknown> & { steps: { id: string; after: string[]; node: Record<string, unknown> }[] } };
    expect(body.baseRevision).toBe(3);
    expect(body.document).not.toHaveProperty("id");
    expect(body.document.title).toBe("Follow-up case (clinic)");
    expect(body.document.steps[1]?.node).toEqual({ type: "STATE", label: "Open", mapsTo: "requested" });
    expect(body.document.steps[2]).toMatchObject({ id: "new-step", after: ["open"], node: { type: "STATE", label: "New step" } });
    expect(body.document.edges).toEqual([{ from: "start", to: "open", label: "case.opened" }]);
  });

  it("is proposed by its own act at the revision read, and not while edits are unsaved", async () => {
    const { calls, editor } = show("draft", () => ({ body: design("proposed") }));
    const propose = within(editor).getByTestId("design-propose");
    expect(propose).toHaveTextContent("Propose r3");
    typeInto(within(editor).getByRole("textbox", { name: /^Summary/ }), "Changed");
    expect(propose).toBeDisabled();
    fireEvent.click(within(editor).getByRole("button", { name: "Discard changes" }));
    expect(propose).toBeEnabled();
    fireEvent.click(propose);
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/design/propose"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/design/propose"))?.body).toEqual({ revision: 3 });
  });
});

describe("what a step and a line may carry beyond what they owe", () => {
  it("offers an owner and rules on a step and a failure on a line, unmarked, and sends what is written", async () => {
    const { calls, editor } = show("draft");
    const open = within(editor).getAllByTestId("step-draft")[1];
    fireEvent.click(within(open).getByRole("button", { name: /Open/ }));
    const optional = within(open).getByTestId("step-optional");
    const owner = within(optional).getByRole("textbox", { name: "Owner" });
    expect(owner).not.toBeRequired();
    typeInto(owner, "Front desk");
    expect(within(optional).getByRole("button", { name: "Add rule" })).toBeInTheDocument();
    typeInto(within(within(editor).getByTestId("line-draft")).getByRole("textbox", { name: "On failure" }), "the slot is released");
    fireEvent.click(within(editor).getByRole("button", { name: "Save draft" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const sent = (calls.find((c) => c.method === "PUT")?.body as { document: { steps: { node: unknown }[]; edges: unknown[] } }).document;
    expect(sent.steps[1]?.node).toEqual({ type: "STATE", label: "Open", mapsTo: "requested", owner: "Front desk" });
    expect(sent.edges[0]).toEqual({ from: "start", to: "open", label: "case.opened", onFailure: "the slot is released" });
  });
});

describe("a design past draft", () => {
  it.each(["approved", "returned", "proposed"] as const)("on a %s design, says the save goes to its approver and offers no separate propose", (status) => {
    const { editor } = show(status);
    expect(within(editor).getByTestId("design-edit-standing")).toHaveTextContent("A save sends it to its approver");
    expect(within(editor).getByRole("button", { name: "Save and send for approval" })).toBeInTheDocument();
    expect(within(editor).queryByTestId("design-propose")).toBeNull();
  });
});

describe("a refused save", () => {
  it("opens the step its path names and draws core's words in it, and keeps the rest under the form", async () => {
    const { editor } = show("draft", () => ({
      status: 422,
      body: {
        error: {
          code: "WORKFLOW_REFUSED",
          message: "refused",
          refusals: [
            { code: "WORKFLOW_NODE_FIELD_MISSING", path: "/steps/1/node/mapsTo", detail: "step open owes mapsTo." },
            { code: "WORKFLOW_EDGE_DANGLING", path: "/edges/0/to", detail: "the line names no step." },
            { code: "STALE_BASE", path: "/baseRevision", detail: "the design moved to r4." },
          ],
        },
      },
    }));
    typeInto(within(editor).getByRole("textbox", { name: /^Title/ }), "x");
    fireEvent.click(within(editor).getByRole("button", { name: "Save draft" }));
    const steps = await within(editor).findAllByTestId("step-draft");
    await vi.waitFor(() => expect(steps[1]).toHaveAttribute("data-refused", "true"));
    expect(steps[0]).not.toHaveAttribute("data-refused");
    expect(within(steps[1]).getByText("step open owes mapsTo.")).toBeInTheDocument();
    expect(within(within(editor).getByTestId("line-draft")).getByText("the line names no step.")).toBeInTheDocument();
    const line = within(editor).getByTestId("design-save-refusal");
    expect(line).toHaveTextContent("the design moved to r4.");
    expect(line).not.toHaveTextContent("owes mapsTo");
  });
});
