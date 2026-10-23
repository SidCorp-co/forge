// A design never approved is taken back from its page: the act asks first, sends the reason given (or
// none), and leaves for the Workflows list it no longer sits in. A design with an approved revision,
// or one already withdrawn, offers no such act; a refusal core names is drawn under it.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import type { DesignStatus, WorkflowDesign } from "../types";
import { WithdrawDesign } from "./design-withdraw";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const design = (status: DesignStatus | null, approvedRevision: number | null = null) => ({ workflowId: "w-1", flow: "judge-k47-test", status, revision: 2, approvedRevision }) as unknown as WorkflowDesign;

function show(d: WorkflowDesign, reply: (c: Call) => { status?: number; body: unknown } = () => ({ body: {} })) {
  const calls = fakeCore((c) => (c.method === "GET" ? HANG : reply(c)));
  renderWithQuery(<WithdrawDesign projectId="p-1" slug="forge" d={d} />);
  return calls;
}

const confirmIn = () => within(screen.getByRole("alertdialog"));

describe("withdrawing a design", () => {
  it("asks first, sends the reason to core's withdraw act and leaves for the Workflows list", async () => {
    const calls = show(design("returned"));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw design" }));
    expect(calls).toHaveLength(0);
    fireEvent.change(confirmIn().getByRole("textbox", { name: /Why/ }), { target: { value: "  a judge's scratch design  " } });
    fireEvent.click(confirmIn().getByRole("button", { name: "Withdraw" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST") as Call;
    expect(post.path).toBe("/projects/p-1/workflows/w-1/design/withdraw");
    expect(post.body).toEqual({ reason: "a judge's scratch design" });
    await vi.waitFor(() => expect(window.location.pathname).toBe("/projects/forge/workflows"));
  });

  it("sends no reason when none is given", async () => {
    const calls = show(design("draft"));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw design" }));
    fireEvent.click(confirmIn().getByRole("button", { name: "Withdraw" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({});
  });

  it("draws core's refusal under the act and stays on the page", async () => {
    show(design("proposed"), () => ({ status: 422, body: { error: { code: "WORKFLOW_REFUSED", message: "refused", refusals: [{ code: "DESIGN_WITHDRAW_PINNED", path: "/", detail: "design `ops` is based on this one" }] } } }));
    window.history.replaceState(null, "", "/projects/forge/workflows/judge-k47-test");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw design" }));
    fireEvent.click(confirmIn().getByRole("button", { name: "Withdraw" }));
    await vi.waitFor(() => expect(screen.getByTestId("design-withdraw-refusal")).toHaveTextContent("based on this one"));
    expect(window.location.pathname).toBe("/projects/forge/workflows/judge-k47-test");
  });

  it.each([
    ["approved", design("approved", 3)],
    ["proposed again after an approval", design("proposed", 3)],
    ["already withdrawn", design("withdrawn")],
    ["outside any design lifecycle", design(null)],
  ])("offers no act on a design %s", (_, d) => {
    show(d);
    expect(screen.queryByRole("button", { name: "Withdraw design" })).toBeNull();
  });
});
