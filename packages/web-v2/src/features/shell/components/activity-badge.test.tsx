// The rail's Activity row carries what its page says waits on the person (ISS-1330): the sum of the
// page's You column from the page's own read, so the menu number never disagrees with the page it
// opens (REQ-11 BC-10). Its tooltip names how many projects hold it, zero draws no badge, and the
// same org frame that moves the page moves the badge. On a phone the More sheet's Activity row and
// the More tab carry the same number.
// @direct-test-of packages/web-v2/src/features/activity/hooks.ts
// @direct-test-of packages/web-v2/src/features/shell/nav-model.ts
// @direct-test-of packages/web-v2/src/features/shell/components/mobile-nav-drawer.tsx
// @direct-test-of packages/web-v2/src/design/patterns/bottom-tab-bar.tsx

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomTabBar } from "@/design";
import { ActivityScreen, useActivityWaiting } from "@/features/activity";
import { FORGE, ORG, QUIET, person, project, read, serve } from "@/test/activity.fixture";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {}, useRooms: () => {} }));
vi.mock("@/features/orgs", async (orig) => ({
  ...(await orig<typeof import("@/features/orgs")>()),
  useActiveOrg: () => ({ orgs: [], activeOrg: null, activeOrgId: ORG, setActiveOrg: () => {}, isSingle: true, resolved: true }),
}));

import { routeEvent } from "@/lib/ws/event-router";
import { bottomTabItems } from "../nav-model";
import { MobileNavDrawer } from "./mobile-nav-drawer";
import { WorkspaceSidebar } from "./workspace-sidebar";

const noop = () => {};
const AHFE = project({
  projectId: "p-ahfe",
  slug: "ahfe-slug",
  name: "AdminHub FE",
  standing: "idle",
  people: { total: 2, items: [person({ decisionId: "answer:ISS-88", key: "ISS-88", title: "Bulk edit" }), person({ decisionId: "answer:ISS-91", key: "ISS-91", title: "Order columns" })] },
});

function Sidebar() {
  return (
    <WorkspaceSidebar
      collapsed={false}
      onToggleCollapsed={noop}
      groupOpen={{}}
      onToggleGroup={noop}
      activeKey="overview"
      attentionCount={0}
      railSlug={null}
      rail={{ projectMark: null, switcherProjects: [], togglePin: noop }}
      badges={{}}
      onNavigate={noop}
      onRoute={noop}
      onSignOut={noop}
      userInitials="OR"
      search={() => null}
      bell={null}
    />
  );
}

/** The phone's tab bar as the shell draws it: More carries the Activity read's count. */
function Tabs() {
  return <BottomTabBar items={bottomTabItems(0, useActivityWaiting())} activeKey="home" onSelect={noop} />;
}

const activityRow = () => within(screen.getByTestId("desktop-rail")).getByRole("button", { name: /^Activity/ });
/** The page's You column, summed as a person reads it. */
const pageTotal = () => screen.getAllByTestId("activity-you").reduce((n, b) => n + Number(b.textContent), 0);

beforeEach(() => window.history.replaceState(null, "", "/activity"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("the rail's Activity row", () => {
  it("carries the sum of the page's You column, named for the projects it spans, and moves with the page on the org's frame", async () => {
    let body = read([FORGE, AHFE, QUIET]);
    const calls = serve(body);
    const { client } = renderWithQuery(
      <>
        <div data-testid="desktop-rail">
          <Sidebar />
        </div>
        <ActivityScreen />
      </>,
    );
    await screen.findByText("Forge");
    await waitFor(() => expect(activityRow().textContent).toContain(String(pageTotal())));
    expect(pageTotal()).toBe(45);
    expect(activityRow().getAttribute("title")).toBe("45 waiting on you across 2 projects");
    // one read for the page and the row: the same query, never a second count computed another way
    expect(calls.filter((c) => c.path === `/orgs/${ORG}/activity`)).toHaveLength(1);

    // answering one of AdminHub FE's: the frame that reads the page again lowers both, without a reload
    body = read([FORGE, { ...AHFE, people: { total: 1, items: AHFE.people.items.slice(0, 1) } }, QUIET]);
    vi.unstubAllGlobals();
    serve(body);
    act(() => {
      routeEvent({ event: "org.activity.changed", data: { orgId: ORG, projectId: "p-ahfe", source: "decision" }, timestamp: new Date().toISOString() }, client);
    });
    await waitFor(() => expect(pageTotal()).toBe(44));
    await waitFor(() => expect(activityRow().textContent).toContain("44"));
    expect(activityRow().getAttribute("title")).toBe("44 waiting on you across 2 projects");
  });

  it("draws no count where nothing waits, and names one project in the singular", async () => {
    serve(read([QUIET]));
    renderWithQuery(
      <div data-testid="desktop-rail">
        <Sidebar />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^Activity/ })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(activityRow().textContent).toBe("Activity");
    expect(activityRow().getAttribute("title")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    serve(read([AHFE, QUIET]));
    renderWithQuery(
      <div data-testid="desktop-rail">
        <Sidebar />
      </div>,
    );
    await waitFor(() => expect(activityRow().getAttribute("title")).toBe("2 waiting on you across 1 project"));
  });
});

describe("on a phone", () => {
  it("the More sheet's Activity row and the More tab carry the page's count", async () => {
    serve(read([FORGE, AHFE, QUIET]));
    renderWithQuery(
      <>
        <MobileNavDrawer
          open
          onClose={noop}
          slug={null}
          railSlug={null}
          railProjectName={null}
          activeKey="overview"
          attentionCount={0}
          badges={{}}
          scopedProjects={[]}
          onNavigate={noop}
          onOpenProject={noop}
          onCreateProject={noop}
          onViewAllProjects={noop}
        />
        <Tabs />
      </>,
    );
    const row = await screen.findByRole("button", { name: /^Activity/ });
    await waitFor(() => expect(row.textContent).toContain("45"));
    // the open sheet is modal, so the tab bar under it is hidden from the reader while it stands open
    const more = screen.getByRole("button", { name: /^More/, hidden: true });
    await waitFor(() => expect(more.textContent).toContain("45"));
    expect(more.getAttribute("aria-label")).toBe("More, 45 waiting on you across 2 projects");
  });

  it("the More tab draws no count where nothing waits", async () => {
    serve(read([QUIET]));
    renderWithQuery(<Tabs />);
    const more = await screen.findByRole("button", { name: "More" });
    await new Promise((r) => setTimeout(r, 50));
    expect(more.textContent).toBe("More");
  });
});
