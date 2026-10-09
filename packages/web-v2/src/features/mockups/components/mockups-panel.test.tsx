// ISS-281 / FB-16: a mockup's Accept applied at one click and sent no reason, though the API keeps
// one on the mockup. Accept now opens a confirm step, and an accepted mockup shows the reason.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { MockupView } from "../types";
import { MockupsPanel } from "./mockups-panel";

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
    can: { accept: true, return: false, withdraw: false },
    ...over,
  }) as unknown as MockupView;

function panel(rows: MockupView[], post: () => { body: unknown } = () => ({ body: { mockup: rows[0] } })) {
  const calls = fakeCore((c) => (c.method === "GET" ? { body: { mockups: rows, returned: rows.length } } : post()));
  renderWithQuery(<MockupsPanel projectId="p1" target={{ type: "feedback", key: "FB-1" }} canPropose={false} />);
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
    panel([mockup({ status: "accepted", reason: "Matches the spec", can: { accept: false, return: false, withdraw: false } } as Partial<MockupView>)]);
    expect(await screen.findByText("Accepted: Matches the spec")).toBeInTheDocument();
  });
});

// REQ-35 (ISS-459): a requirement's picture is each revision's own, shown at once with no accept,
// so its Mockups tab keeps the earlier mockups as history and takes no proposal. Its lead said a
// person other than the author accepts, which core never required (`mockups/rules.ts:deciderRefusal`).
describe("a requirement's Mockups tab", () => {
  const requirementPanel = () => {
    fakeCore(() => ({ body: { mockups: [], returned: 0 } }));
    renderWithQuery(<MockupsPanel projectId="p1" target={{ type: "requirement", key: "REQ-1", revision: 1 }} />);
  };

  it("offers no proposal, even when the caller would let one through", async () => {
    requirementPanel();
    await screen.findByText("No mockup was proposed for this requirement.");
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
  });

  // ISS-459 judge: the empty tab still read "No mockup proposed yet.", promising a proposal that can no longer be made
  it("says none was proposed for it, never that one is yet to come", async () => {
    requirementPanel();
    const tab = await screen.findByTestId("view-mockups");
    await screen.findByText("No mockup was proposed for this requirement.");
    expect(tab).not.toHaveTextContent(/proposed yet/);
  });

  it("an item tab with none still says one may be proposed", async () => {
    panel([]);
    expect(await screen.findByText("No mockup proposed yet.")).toBeInTheDocument();
  });

  it("says the revision's picture replaces mockups, and never that someone other than the author accepts", async () => {
    requirementPanel();
    const tab = await screen.findByTestId("view-mockups");
    expect(tab).toHaveTextContent("A requirement's picture now belongs to each revision");
    expect(tab).not.toHaveTextContent(/other than its author/);
  });
});
