import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_ITEMS,
  PROJECT_MENU,
  buildActiveKey,
  buildBottomActiveKey,
  ecosystemHref,
  ecosystemMenu,
  isProjGroup,
  projectMenu,
  projectRailItems,
} from "./nav-model";

const PROJECT_ROUTES = join(__dirname, "../../app/(workspace)/projects/[slug]");

const WORKSPACE_ROUTES = join(__dirname, "../../app/(workspace)");

describe("the Ecosystem group", () => {
  const read = {
    ecosystems: [
      { id: "e1", name: "QA Eco", code: "QE", members: ["p1"], steward: { id: "o1", name: "SidCorp", mine: false } },
      { id: "e2", name: "Invited", code: "IN", members: [], steward: { id: "o2", name: "Other", mine: false } },
    ],
    threads: [],
    drafts: [],
    invitations: [],
    projects: [],
    mine: ["p1"],
  } as unknown as Parameters<typeof ecosystemMenu>[0];

  it("is Threads, one row per ecosystem the person belongs to, and New ecosystem — nothing else", () => {
    expect(ecosystemMenu(read).map((i) => [i.label, i.mark])).toEqual([
      ["Threads", undefined],
      ["QA Eco", "QE"],
      ["New ecosystem", undefined],
    ]);
  });

  it.each(["eco-threads", "eco-new", "eco:e1"])("links %s to a page that exists", (key) => {
    const href = ecosystemHref(key) as string;
    const path = href.replace("/e1", "/[id]");
    expect(existsSync(join(WORKSPACE_ROUTES, path, "page.tsx"))).toBe(true);
  });

  it("lights the row the route is on", () => {
    expect(buildActiveKey("/ecosystems/threads", null)).toBe("eco-threads");
    expect(buildActiveKey("/ecosystems/new", null)).toBe("eco-new");
    expect(buildActiveKey("/ecosystems/e1", "forge-dev")).toBe("eco:e1");
    expect(buildActiveKey("/projects/forge-dev/issues", "forge-dev")).toBe("proj-issues");
  });
});

describe("the project menu", () => {
  it("is Dashboard, Requirements, Workflows, Issues, Agents, Automation and Releases, in that order", () => {
    expect(PROJECT_MENU.map((e) => e.label)).toEqual([
      "Dashboard",
      "Requirements",
      "Workflows",
      "Issues",
      "Agents",
      "Automation",
      "Releases",
    ]);
  });

  it("holds Schedules and Improvements under Automation, and nothing else there", () => {
    const group = PROJECT_MENU.find(isProjGroup);
    expect(group?.label).toBe("Automation");
    expect(group?.items.map((i) => i.sub)).toEqual(["/automation/schedules", "/automation/improvements"]);
  });

  it.each(PROJECT_ITEMS.map((it) => [it.label, it.sub] as const))("links %s to a page that exists", (_, sub) => {
    expect(existsSync(join(PROJECT_ROUTES, sub, "page.tsx"))).toBe(true);
  });

  it("names no Library, Board, Insights, Modules or PM destination", () => {
    const labels = PROJECT_ITEMS.map((it) => it.label);
    for (const gone of ["Library", "Board", "Insights", "Modules", "PM", "Improve", "Feedback"]) {
      expect(labels).not.toContain(gone);
    }
    expect(existsSync(join(PROJECT_ROUTES, "library"))).toBe(false);
  });

  it("lights each Automation page, Releases, a version address included, Workflows and Requirements", () => {
    const at = (sub: string) => buildActiveKey(`/projects/forge-dev${sub}`, "forge-dev");
    expect(at("/automation/schedules")).toBe("proj-schedules");
    expect(at("/automation/improvements")).toBe("proj-improvements");
    expect(at("/releases")).toBe("proj-releases");
    expect(at("/releases/0.42.1")).toBe("proj-releases");
    expect(at("/workflows")).toBe("proj-workflows");
    expect(at("/requirements")).toBe("proj-requirements");
    expect(at("/requirements/REQ-3")).toBe("proj-requirements");
  });

  it("badges Issues with open issues and Releases with versions awaiting approval", () => {
    const badges = { openIssues: 12, awaitingApproval: 1 };
    const flat = projectMenu(badges).flatMap((e) => (isProjGroup(e) ? e.items : [e]));
    expect(Object.fromEntries(flat.map((i) => [i.key, i.badge]))).toMatchObject({
      "proj-issues": 12,
      "proj-releases": 1,
      "proj-schedules": undefined,
    });
    expect(projectRailItems(badges).find((i) => i.key === "proj-releases")?.badge).toBe(1);
  });
});

describe("the bottom tabs", () => {
  it("light Chat while the dock is open and More while the drawer is, whatever the route", () => {
    expect(buildBottomActiveKey("/projects/x/issues", false, true)).toBe("chat");
    expect(buildBottomActiveKey("/projects/x/issues", true, true)).toBe("more");
    expect(buildBottomActiveKey("/attention", false, false)).toBe("attention");
    expect(buildBottomActiveKey("/projects/x/issues", false, false)).toBe("home");
  });
});
