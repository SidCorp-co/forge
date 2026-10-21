// ISS-281 / FB-16: a mockup's Accept applied at one click and sent no reason, though the API keeps
// one on the mockup. Accept now opens a confirm step, and an accepted mockup shows the reason.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { MockupView } from "../types";
import { MockupList } from "./mockups-panel";

afterEach(() => vi.unstubAllGlobals());

const mockup = (over: Partial<MockupView> = {}): MockupView =>
  ({
    id: "m1",
    key: "MK-1",
    kind: "json",
    name: "example.json",
    caption: "Checkout example",
    status: "proposed",
    reason: null,
    pinned: null,
    proposedByName: "Bo",
    proposedAgency: "human",
    target: { type: "feedback", key: "FB-1", revision: null },
    url: "/api/projects/p1/mockups/MK-1/content",
    createdAt: "2026-10-06T17:00:00.000Z",
    round: 1,
    revises: null,
    revisedBy: null,
    comments: { total: 0, open: 0 },
    can: { accept: true, return: false, withdraw: false, comment: false, revise: false },
    ...over,
  }) as unknown as MockupView;

function panel(rows: MockupView[], post: () => { body: unknown } = () => ({ body: { mockup: rows[0] } })) {
  const calls = fakeCore((c) => (c.method === "GET" ? { body: { mockups: rows, returned: rows.length } } : post()));
  renderWithQuery(<MockupList projectId="p1" slug="acme" target={{ type: "feedback", key: "FB-1" }} canPropose={false} />);
  return calls;
}

describe("accepting a mockup", () => {
  it("opens a confirm step and sends the typed reason", async () => {
    const calls = panel([mockup()]);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const step = screen.getByTestId("accept-step");
    fireEvent.change(within(step).getByRole("textbox", { name: "Why it is accepted, and on whose authority" }), { target: { value: "Matches the spec" } });
    fireEvent.click(within(step).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/mockups/MK-1/accept", body: { reason: "Matches the spec" } },
      ]),
    );
  });

  // ISS-281's judge: a second press on Accept closed the open step and dropped the typed reason
  it("keeps the typed reason: Accept is off while the step is open, and Cancel closes it", async () => {
    const calls = panel([mockup()]);
    const opener = await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(opener);
    fireEvent.change(within(screen.getByTestId("accept-step")).getByRole("textbox"), { target: { value: "Matches the spec" } });
    expect(opener).toBeDisabled();
    fireEvent.click(opener);
    expect(within(screen.getByTestId("accept-step")).getByRole("textbox")).toHaveValue("Matches the spec");
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("accept-step")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("shows an accepted mockup's reason as the accept's", async () => {
    panel([mockup({ status: "accepted", reason: "Matches the spec", can: { accept: false, return: false, withdraw: false, comment: false, revise: false } })]);
    expect(await screen.findByText("Accepted: Matches the spec")).toBeInTheDocument();
  });
});

// REQ-49 reverses REQ-35's history-only tab: a requirement's mockups are proposed on it again, at its
// open draft or current revision, and its tab says nothing about pictures or who accepts.
describe("a requirement's Mockups tab", () => {
  const requirementPanel = () => {
    const calls = fakeCore((c) => (c.method === "GET" ? { body: { mockups: [], returned: 0, open: 0 } } : { body: { mockup: mockup() } }));
    renderWithQuery(<MockupList projectId="p1" slug="acme" target={{ type: "requirement", key: "REQ-1" }} />);
    return calls;
  };

  it("takes a proposal, sent on the requirement with no revision for core to pick", async () => {
    const calls = requirementPanel();
    await screen.findByText("None yet");
    fireEvent.change(screen.getByTestId("mockup-file"), {
      target: { files: [new File(["<p>cart</p>"], "cart.html", { type: "text/html" })] },
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: "/projects/p1/mockups",
      body: { target: { requirement: "REQ-1" }, kind: "html", name: "cart.html" },
    });
  });

  it("explains nothing about pictures or who accepts", async () => {
    requirementPanel();
    const tab = await screen.findByTestId("view-mockups");
    await screen.findByText("None yet");
    expect(tab).not.toHaveTextContent(/picture/);
    expect(tab).not.toHaveTextContent(/other than its author/);
  });
});
