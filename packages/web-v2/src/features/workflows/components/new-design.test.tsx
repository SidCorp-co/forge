// A design started by hand from the Workflows list (lane 3): a title, a summary and the template it is
// drawn in make a draft core stores, starting from the template's own example — or, for a template
// with none, from a first step written in the dialog — and its page opens on the Edit view. Nothing is
// sent until each part is written; a refusal core names is drawn on the field its path names.

import { BUILTIN_WORKFLOW_TEMPLATES, type WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { NewDesign } from "./new-design";

const push = vi.fn();
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push, replace: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

const STATES = BUILTIN_WORKFLOW_TEMPLATES.find((x) => x.id === "state-machine") as WorkflowTemplate;
// a project's own template: the kernel holds no example for it
const OWN = { ...STATES, id: "clinic-states", title: "Clinic states" } as WorkflowTemplate;

/** The template's example as core serves it, with what points outside the design: a ref and a wireframe. */
const EXAMPLE = {
  version: 2,
  project: "00000000-0000-4000-8000-000000000000",
  flow: "case-lifecycle",
  kind: "state",
  title: "Follow-up case",
  summary: "A case opens and closes.",
  template: { id: "state-machine", version: 1 },
  steps: [
    { id: "start", does: "The machine starts.", after: [], node: { type: "INITIAL" } },
    { id: "open", does: "The case waits.", after: ["start"], node: { type: "STATE", label: "Open", refs: [{ template: "ux-flow", flow: "x", step: "y" }], wireframe: { attachment: "b0" } } },
  ],
  edges: [{ from: "start", to: "open", label: "case.opened" }],
  writtenBy: {},
};

function open(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls = fakeCore((c) => {
    if (c.method !== "GET") return reply(c);
    if (c.path === "/projects/p-1/workflow-templates/state-machine/1") return { body: { origin: "builtin", template: STATES, example: EXAMPLE } };
    if (c.path === "/projects/p-1/workflow-templates/clinic-states/1") return { body: { origin: "project", template: OWN, example: null } };
    return HANG;
  });
  renderWithQuery(<NewDesign projectId="p-1" slug="hop" templates={[STATES, OWN]} />);
  fireEvent.click(screen.getByTestId("new-design"));
  return { calls, form: screen.getByTestId("new-design-form") };
}

const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

function head(form: HTMLElement) {
  typeInto(within(form).getByRole("textbox", { name: /^Title/ }), "Đặt lịch khám"); // i18n-allow: a Vietnamese title is the case the flow is folded from
  typeInto(within(form).getByRole("textbox", { name: /^Summary/ }), "A patient books a visit.");
}

describe("a new design from its template's example", () => {
  it("sends nothing until its title and summary are written and the example is read", async () => {
    const { form } = open(() => ({ body: {} }));
    const create = within(form).getByRole("button", { name: "Create draft" });
    expect(create).toBeDisabled();
    head(form);
    expect(await within(form).findByTestId("new-design-from-example")).toHaveTextContent("2 steps");
    expect(create).toBeEnabled();
    expect(within(form).queryByTestId("new-design-first-step")).toBeNull();
  });

  it("is created as a draft retitled as written, its flow read from the title, without what points outside it, and opens on Edit", async () => {
    const { calls, form } = open(() => ({ status: 201, body: {} }));
    head(form);
    await within(form).findByTestId("new-design-from-example");
    fireEvent.click(within(form).getByRole("button", { name: "Create draft" }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/projects/hop/workflows/dat-lich-kham?tab=edit"));
    const post = calls.find((c) => c.method === "POST") as Call;
    expect(post.path).toBe("/projects/p-1/workflows");
    expect(post.body).toMatchObject({
      baseRevision: null,
      document: { version: 2, project: "p-1", flow: "dat-lich-kham", kind: "state", title: "Đặt lịch khám", summary: "A patient books a visit.", template: { id: "state-machine", version: 1 }, edges: EXAMPLE.edges }, // i18n-allow: a Vietnamese title is the case the flow is folded from
    });
    const steps = (post.body as { document: { steps: { node: Record<string, unknown> }[] } }).document.steps;
    expect(steps.map((s) => s.node)).toEqual([{ type: "INITIAL" }, { type: "STATE", label: "Open" }]);
  });

  it("draws a refusal at its flow on the title it was read from", async () => {
    const { form } = open(() => ({ status: 422, body: { error: { code: "WORKFLOW_REFUSED", message: "refused", refusals: [{ code: "WORKFLOW_DUPLICATE", path: "/flow", detail: "a design named dat-lich-kham exists." }] } } }));
    head(form);
    await within(form).findByTestId("new-design-from-example");
    fireEvent.click(within(form).getByRole("button", { name: "Create draft" }));
    expect(await within(form).findByRole("textbox", { name: /^Title/, description: "a design named dat-lich-kham exists." })).toHaveAttribute("aria-invalid", "true");
    expect(within(form).queryByTestId("new-design-refusal")).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("a new design from a template with no example", () => {
  it("asks for its first step and sends it as written", async () => {
    const { calls, form } = open(() => ({ status: 201, body: {} }));
    const user = userEvent.setup();
    await user.click(within(form).getByRole("combobox", { name: /Diagram type/ }));
    await user.click(await screen.findByRole("option", { name: "Clinic states" }));
    head(form);
    const first = await within(form).findByTestId("new-design-first-step");
    const create = within(form).getByRole("button", { name: "Create draft" });
    expect(create).toBeDisabled();
    typeInto(within(first).getByRole("textbox", { name: /^Name on the card/ }), "Booking starts");
    typeInto(within(first).getByRole("textbox", { name: /^What happens/ }), "The patient opens the booking page.");
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect((calls.find((c) => c.method === "POST")?.body as { document: unknown }).document).toMatchObject({
      template: { id: "clinic-states", version: 1 },
      steps: [{ id: "booking-starts", does: "The patient opens the booking page.", after: [], node: { type: "INITIAL", label: "Booking starts" } }],
    });
  });
});
