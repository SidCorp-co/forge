// @vitest-environment jsdom
//
// ISS-1171 — the Connections directory with nothing in it offered no way to add a connection:
// it named the page to go to in prose and left the reader to find it. The empty directory now
// carries the one act that fills it, a link to a project's own Integrations settings in this space.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACME = { id: "org-team", name: "Acme QA Org", isPersonal: false, role: "owner" };
/** The space the screen stands in; a case that names its own org replaces it. */
let TEAM = ACME;
const OTHER = { id: "org-other", name: "Elsewhere", isPersonal: false, role: "owner" };

type ProjectRow = { id: string; slug: string; name: string; orgId: string; archivedAt: string | null };

let connections: ConnectionDirectoryItem[] = [];
let projects: ProjectRow[] = [];
/** How the projects read stands, where a case plants one that has not landed or failed. */
let projectsRead: "done" | "pending" | "failed" = "done";
const refetchProjects = vi.fn();

vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useConnections: () => ({
    data: { items: connections },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: TEAM, orgs: [TEAM, OTHER] }),
}));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [TEAM, OTHER] }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({
    data: projectsRead === "done" ? projects : undefined,
    isError: projectsRead === "failed",
    refetch: refetchProjects,
  }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { IntegrationsScreen } = await import("./integrations-screen");

expect.extend(matchers);

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  id: "p1",
  slug: "desk",
  name: "Desk",
  orgId: TEAM.id,
  archivedAt: null,
  ...over,
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntegrationsScreen />
    </QueryClientProvider>,
  );
  return within(screen.getByTestId("connections-empty"));
}

beforeEach(() => {
  TEAM = ACME;
  connections = [];
  projects = [];
  projectsRead = "done";
  refetchProjects.mockClear();
});
afterEach(cleanup);

describe("an empty Connections directory", () => {
  it("links the one project in this space to its Integrations settings", () => {
    projects = [row({}), row({ id: "p2", slug: "far", name: "Far", orgId: OTHER.id })];
    const empty = mount();
    expect(empty.getByRole("link", { name: "Add a connection in Desk" })).toHaveAttribute(
      "href",
      "/projects/desk/settings?tab=integrations",
    );
  });

  it("lets the reader pick which of several projects in this space, leaving out archived ones and other spaces'", () => {
    projects = [
      row({}),
      row({ id: "p2", slug: "shop", name: "Shop" }),
      row({ id: "p3", slug: "old", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" }),
      row({ id: "p4", slug: "far", name: "Far", orgId: OTHER.id }),
    ];
    const empty = mount();
    const picker = empty.getByRole("combobox", { name: "Project to add a connection in" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Desk", "Shop"]);
    const add = empty.getByRole("link", { name: "Add a connection in this project" });
    expect(add).toHaveAttribute("href", "/projects/desk/settings?tab=integrations");
    fireEvent.change(picker, { target: { value: "shop" } });
    expect(add).toHaveAttribute("href", "/projects/shop/settings?tab=integrations");
  });

  it("offers to create a project where this space has none to add a connection from", () => {
    projects = [row({ orgId: OTHER.id })];
    const empty = mount();
    expect(empty.getByText(/There is no project in Acme QA Org yet/)).toBeInTheDocument();
    expect(empty.getByRole("link", { name: "Create a project" })).toHaveAttribute("href", "/projects?new=1");
  });

  it("still offers the act where the reader holds connections only in other spaces", () => {
    projects = [row({})];
    connections = [
      {
        id: "c1",
        ownerType: "org",
        ownerId: OTHER.id,
        provider: "github",
        displayName: "Elsewhere App",
        config: {},
        active: true,
        lastHealthStatus: "ok",
        lastHealthAt: null,
        breakerOpenedAt: null,
        hasSecrets: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        usage: { bindings: [] },
        access: { reach: "owner", canManage: true, ownerName: null },
      } as unknown as ConnectionDirectoryItem,
    ];
    const empty = mount();
    expect(empty.getByText("No connections in Acme QA Org")).toBeInTheDocument();
    expect(empty.getByRole("link", { name: "Add a connection in Desk" })).toBeInTheDocument();
  });

  it("says nothing of projects while their read has not landed", () => {
    projectsRead = "pending";
    const empty = mount();
    expect(empty.queryByTestId("add-connection")).toBeNull();
    expect(empty.queryByText(/no project in/)).toBeNull();
  });

  it("says a failed projects read failed, never that the space has no project, and reads again on request", () => {
    projectsRead = "failed";
    const empty = mount();
    expect(empty.queryByText(/no project in/)).toBeNull();
    expect(empty.queryByRole("link", { name: "Create a project" })).toBeNull();
    expect(empty.getByText(/The projects in Acme QA Org could not be read/)).toBeInTheDocument();
    fireEvent.click(empty.getByRole("button", { name: "Read them again" }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });
});

// Judge-14 at c76f5fa: the zero-projects line printed the org "j14 scratch org" as "J14 scratch org"
// two lines under a heading that printed it as stored. A name is printed as its owner typed it.
describe("a name on the empty Connections page", () => {
  const LOWER_ORG = "j14 scratch org";
  const LOWER_PROJECT = "j14 scratch";
  // jsdom applies no stylesheet, so a class that re-cases is read off the element itself.
  const RECASING_CLASS = /(^|\s)(capitalize|uppercase|lowercase|fg-overline)(\s|$)/;

  /** Every printed occurrence of either name, with the classes on the element and its ancestors. */
  function printedNames(): { text: string; classes: string }[] {
    const found: { text: string; classes: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const classes: string[] = [];
      for (let el = node.parentElement; el; el = el.parentElement) classes.push(el.className);
      for (const m of (node.textContent ?? "").matchAll(/j14 scratch( org)?/gi)) {
        found.push({ text: m[0], classes: classes.join(" ") });
      }
    }
    return found;
  }

  function expectPrintedAsTyped() {
    const names = printedNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect([LOWER_ORG, LOWER_PROJECT]).toContain(name.text);
      expect(name.classes).not.toMatch(RECASING_CLASS);
    }
  }

  beforeEach(() => {
    TEAM = { ...ACME, name: LOWER_ORG };
  });

  it("prints a lower-case org as stored where the space holds no project", () => {
    projects = [row({ orgId: OTHER.id })];
    const empty = mount();
    expect(empty.getByRole("link", { name: "Create a project" })).toBeInTheDocument();
    expectPrintedAsTyped();
  });

  it("prints a lower-case project and org as stored where the space holds one project", () => {
    projects = [row({ slug: "j14-scratch", name: LOWER_PROJECT })];
    const empty = mount();
    expect(empty.getByRole("link", { name: `Add a connection in ${LOWER_PROJECT}` })).toBeInTheDocument();
    expectPrintedAsTyped();
  });

  it("prints a lower-case org as stored where the projects read failed", () => {
    projectsRead = "failed";
    mount();
    expectPrintedAsTyped();
  });

  it("prints a lower-case org as stored where connections sit only in other spaces", () => {
    projects = [row({ slug: "j14-scratch", name: LOWER_PROJECT })];
    connections = [
      {
        id: "c1",
        ownerType: "org",
        ownerId: OTHER.id,
        provider: "github",
        displayName: "Elsewhere App",
        config: {},
        active: true,
        lastHealthStatus: "ok",
        lastHealthAt: null,
        breakerOpenedAt: null,
        hasSecrets: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        usage: { bindings: [] },
        access: { reach: "owner", canManage: true, ownerName: null },
      } as unknown as ConnectionDirectoryItem,
    ];
    const empty = mount();
    expect(empty.getByText(`No connections in ${LOWER_ORG}`)).toBeInTheDocument();
    expectPrintedAsTyped();
  });
});

// ISS-1229 r47, judge-137: with the projects read failing, a space whose connections are known only through
// its projects read "No connections in <org>", and "You can see N in your other spaces".
describe("a Connections directory whose projects cannot be read", () => {
  it("says the projects could not be loaded, as the page's one heading, and reads them again on Retry", () => {
    projectsRead = "failed";
    connections = [
      {
        id: "c1",
        ownerType: "org",
        ownerId: OTHER.id,
        provider: "github",
        displayName: "Shared App",
        config: {},
        active: true,
        lastHealthStatus: "ok",
        lastHealthAt: null,
        breakerOpenedAt: null,
        hasSecrets: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        usage: { bindings: [{ projectId: "p1" }] },
        access: { reach: "binding", canManage: false, ownerName: "Elsewhere" },
      } as unknown as ConnectionDirectoryItem,
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <IntegrationsScreen />
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Couldn't load your projects",
    ]);
    expect(document.title).toBe("Couldn't load your projects · Forge");
    expect(screen.queryByText(/No connections in|in your other spaces/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });
});
