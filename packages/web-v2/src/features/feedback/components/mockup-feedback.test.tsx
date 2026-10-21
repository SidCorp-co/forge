// REQ-49 BC-4: feedback about a mockup is filed from the mockup open full screen, with the mockup as
// its target. The view is the mockups feature's and the form this one's, handed down through
// MockupFeedback as the workspace mounts it; the About picker offers Mockup only there.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockupList } from "@/features/mockups";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { MockupFeedback } from "./mockup-feedback";

const MOCKUP = {
  id: "MK-1",
  key: "MK-1",
  target: { type: "requirement", key: "REQ-1", revision: 1 },
  kind: "html",
  name: "cart.html",
  mime: "text/html",
  size: 10,
  caption: null,
  status: "proposed",
  proposedBy: "u1",
  proposedByName: "Bo",
  proposedAgency: "human",
  createdAt: "2026-10-21T08:00:00.000Z",
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  reason: null,
  pinned: null,
  round: 1,
  revises: null,
  revisedBy: null,
  comments: { total: 0, open: 0 },
  url: "/api/projects/p1/mockups/MK-1/content",
  can: { accept: true, return: true, withdraw: false, comment: true, revise: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("feedback about a mockup (BC-4)", () => {
  it("is filed from its full-screen view with the mockup as its target", async () => {
    const calls = fakeCore((c: Call) => {
      if (c.path === "/projects") return { body: [{ id: "p1", role: "member" }] };
      if (c.path === "/projects/p1/feedback") return { status: 201, body: { feedback: { key: "FB-9" } } };
      if (c.path.endsWith("/comments")) return { body: { comments: [], open: 0 } };
      if (c.path.includes("/content")) return { file: "<p>cart</p>", headers: { "content-type": "text/html" } };
      return { body: { mockups: [MOCKUP], returned: 1, open: 1 } };
    });
    window.history.replaceState(null, "", "/projects/acme/requirements/REQ-1?mockup=MK-1&full=1");
    renderWithQuery(
      <MockupFeedback>
        <MockupList projectId="p1" slug="acme" target={{ type: "requirement", key: "REQ-1" }} />
      </MockupFeedback>,
    );
    const viewer = await screen.findByTestId("mockup-viewer");
    fireEvent.click(within(viewer).getByTestId("mockup-feedback-open"));
    const kinds = await screen.findByLabelText<HTMLSelectElement>("Target type");
    expect(kinds.value).toBe("mockup");
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Approve all acts at once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    const filed = () => calls.find((c) => c.method === "POST" && c.path === "/projects/p1/feedback");
    await waitFor(() => expect(filed()).toBeDefined());
    expect(filed()?.body).toMatchObject({ mockup: "MK-1", title: "Approve all acts at once" });
  });
});
