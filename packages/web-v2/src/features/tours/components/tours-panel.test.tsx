// Help → Tours lists every tour with how the person stands at its revision: Seen, Not seen, or an
// Updated dot when the screen moved on since they finished it. The inline hint is offered, never forced.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { TOUR_STATES_KEY } from "../hooks";
import { TourHint } from "./tour-hint";
import { ToursPanel } from "./tours-panel";

vi.mock("@forge/contracts/tours", async (actual) => {
  const real = await actual<typeof import("@forge/contracts/tours")>();
  return {
    ...real,
    PRODUCT_TOURS: real.PRODUCT_TOURS.map((t) => (t.id === "integrations" ? { ...t, revision: 2 } : t)),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/forge/settings",
}));

const at = "2026-10-07T09:00:00Z";

function serve(items: unknown[]): Call[] {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path === "/me/product-state") return { body: { items } };
    if (call.method === "PUT") return { body: { key: call.path.split("/").pop(), value: call.body, updatedAt: at } };
    return undefined;
  });
}

describe("Help → Tours", () => {
  it("reads Not seen, and Updated with a dot for a tour finished at an older revision", async () => {
    serve([{ key: "tour:integrations", value: { revision: 1, outcome: "completed", at }, updatedAt: at }]);
    renderWithQuery(<ToursPanel open onClose={() => {}} />);
    const integrations = await screen.findByTestId("tour-row-integrations");
    await within(integrations).findByText(/revision 2 · Updated/);
    expect(within(integrations).getByTestId("tour-updated-dot")).toBeInTheDocument();
    const release = screen.getByTestId("tour-row-release-what-changes");
    expect(release).toHaveTextContent("2 steps · revision 2 · Not seen");
    expect(within(release).queryByTestId("tour-updated-dot")).toBeNull();
  });

  it("reads Seen for a tour finished at its revision", async () => {
    serve([{ key: "tour:release-what-changes", value: { revision: 2, outcome: "completed", at }, updatedAt: at }]);
    renderWithQuery(<ToursPanel open onClose={() => {}} />);
    expect(await screen.findByText(/revision 2 · Seen/)).toBeInTheDocument();
  });
});

describe("the inline first-visit hint", () => {
  it("offers the tour on a first visit, and Later sets it aside at this revision", async () => {
    const calls = serve([]);
    renderWithQuery(<TourHint tourId="integrations" projectRole="admin" />);
    const hint = await screen.findByTestId("tour-hint-integrations");
    expect(hint).toHaveTextContent("A quick look in 3 steps?");
    await userEvent.click(within(hint).getByRole("button", { name: "Later" }));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/me/product-state/tour:integrations");
    expect(put?.body).toMatchObject({ value: { revision: 2, outcome: "dismissed" } });
  });

  it("is not offered to a role outside the tour's audience, nor once set aside at this revision", async () => {
    serve([]);
    const viewer = renderWithQuery(<TourHint tourId="integrations" projectRole="viewer" />);
    await waitFor(() => expect(viewer.client.getQueryState(TOUR_STATES_KEY)?.status).toBe("success"));
    expect(screen.queryByTestId("tour-hint-integrations")).toBeNull();
    viewer.unmount();
    serve([{ key: "tour:integrations", value: { revision: 2, outcome: "dismissed", at }, updatedAt: at }]);
    const admin = renderWithQuery(<TourHint tourId="integrations" projectRole="admin" />);
    await waitFor(() => expect(admin.client.getQueryState(TOUR_STATES_KEY)?.status).toBe("success"));
    expect(screen.queryByTestId("tour-hint-integrations")).toBeNull();
  });

  it("is offered again, worded as a change, when the revision rose since the person finished it", async () => {
    serve([{ key: "tour:integrations", value: { revision: 1, outcome: "completed", at }, updatedAt: at }]);
    renderWithQuery(<TourHint tourId="integrations" projectRole="admin" />);
    expect(await screen.findByTestId("tour-hint-integrations")).toHaveTextContent("This screen just changed");
  });
});
