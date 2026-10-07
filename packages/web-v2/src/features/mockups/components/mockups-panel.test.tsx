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

  it("shows an accepted mockup's reason as the accept's", async () => {
    panel([mockup({ status: "accepted", reason: "Matches the spec", can: { accept: false, return: false, withdraw: false } } as Partial<MockupView>)]);
    expect(await screen.findByText("Accepted: Matches the spec")).toBeInTheDocument();
  });
});
