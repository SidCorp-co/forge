// Help → Tours is mounted by the rail, outside the page, so the project it resolves has to come
// from the layout's own chain. This renders that chain over a /projects/<slug>/… route; a panel
// handed a project by its test cannot show that the rail has none to hand it.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "@/test/render";
import { componentOf, renderRoute } from "@/test/route-tree";

const nav = vi.hoisted(() => ({ search: "tab=connections" }));

vi.mock("@/lib/utils/use-location-search", () => ({ useLocationSearch: () => nav.search }));
const started = vi.hoisted(() => ({ tours: [] as string[] }));
vi.mock("@/features/tours/run-tour", async (actual) => {
  const real = await actual<typeof import("@/features/tours/run-tour")>();
  return {
    ...real,
    runTour: (tour: { id: string }) => {
      started.tours.push(tour.id);
      return true;
    },
  };
});

import { Route as WorkspaceRoute } from "./_workspace/route";

const WorkspaceLayout = componentOf(WorkspaceRoute, "routes/_workspace/route.tsx");

const project = { id: "p1", slug: "forge", name: "Forge", role: "admin", orgId: null };

function serve() {
  return fakeCore((call) => {
    if (call.method === "GET" && call.path.startsWith("/projects") && !call.path.startsWith("/projects/")) return { body: [project] };
    if (call.path === "/me/product-state") return { body: { items: [] } };
    if (call.path.startsWith("/me/whats-new")) return { body: { environment: "dev", release: null } };
    if (call.path.endsWith("/releases")) return { body: { releases: [{ version: "0.4.0", current: true }], counts: {} } };
    if (call.method === "POST" || call.method === "PUT") return { body: {} };
    return { status: 404, body: { code: "NOT_SERVED" } };
  });
}

beforeEach(() => {
  // jsdom lays nothing out, so an element would read as undrawn
  Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  started.tours.length = 0;
});

describe("tours in the workspace layout", () => {
  it("Help → Tours on another page of the project takes each tour to its page", async () => {
    nav.search = "";
    serve();
    const { router } = await renderRoute({ at: "/projects/forge/releases", pattern: "/projects/$slug/releases", page: () => <div />, layout: WorkspaceLayout });
    await userEvent.click((await screen.findAllByRole("button", { name: /Help/ }))[0]);
    const integrations = await screen.findByTestId("tour-row-integrations");
    const release = screen.getByTestId("tour-row-release-what-changes");
    await waitFor(() => expect(within(release).getByRole("button", { name: "Show" })).toBeEnabled());
    expect(integrations).not.toHaveTextContent("Open a project first");
    await userEvent.click(within(integrations).getByRole("button", { name: "Show" }));
    await waitFor(() => expect(router.state.location.href).toBe("/projects/forge/settings?tab=connections&tour=integrations"));
  });

  it("?tour= on the tour's page starts it at step 1", async () => {
    nav.search = "tab=connections&tour=integrations";
    serve();
    await renderRoute({
      at: "/projects/forge/settings?tab=connections&tour=integrations",
      pattern: "/projects/$slug/settings",
      page: () => <div data-tour="int-status" style={{ width: 10, height: 10 }} />,
      layout: WorkspaceLayout,
    });
    await waitFor(() => expect(started.tours).toEqual(["integrations"]));
  });
});
