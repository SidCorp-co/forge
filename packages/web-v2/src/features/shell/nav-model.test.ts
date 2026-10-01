import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ECOSYSTEM_ITEMS,
  PROJECT_ITEMS,
  PROJECT_MENU,
  buildActiveKey,
  buildBottomActiveKey,
  buildCrumbs,
  isProjGroup,
  projectMenu,
  projectRailItems,
} from "./nav-model";

const PROJECT_ROUTES = join(__dirname, "../../app/(workspace)/projects/[slug]");

describe("the Activity sidebar's Ecosystem group", () => {
  it.each(ECOSYSTEM_ITEMS.map((it) => [it.label, it] as const))("links %s to a page that exists", (_, it) => {
    const href = it.href("forge-dev");
    const path = href.split("?")[0] as string;
    const sub = path.replace("/projects/forge-dev", "");
    expect(existsSync(join(PROJECT_ROUTES, sub, "page.tsx"))).toBe(true);
  });

  it("offers the register filtered to awaiting, overdue and held", () => {
    expect(ECOSYSTEM_ITEMS.flatMap((it) => (it.status ? [it.href("forge-dev")] : []))).toEqual([
      "/projects/forge-dev/ecosystem/channel?status=awaiting",
      "/projects/forge-dev/ecosystem/channel?status=overdue",
      "/projects/forge-dev/ecosystem/channel?status=held",
    ]);
  });

  it("lights the row the route is on, filter included", () => {
    const at = (path: string, search = "") => buildActiveKey(path, "forge-dev", search);
    expect(at("/projects/forge-dev/ecosystem/channel")).toBe("eco-channel");
    expect(at("/projects/forge-dev/ecosystem/channel", "?status=held")).toBe("eco-held");
    expect(at("/projects/forge-dev/ecosystem/channel/FP-CN-12")).toBe("eco-channel");
    expect(at("/projects/forge-dev/ecosystem/contracts/orders")).toBe("eco-contracts");
    expect(at("/projects/forge-dev/ecosystem/api")).toBe("eco-api");
    expect(at("/projects/forge-dev/issues")).toBe("proj-issues");
  });

  it("names the page in the breadcrumb", () => {
    const crumbs = buildCrumbs({
      pathname: "/projects/forge-dev/ecosystem/api",
      slug: "forge-dev",
      activeKey: "eco-api",
      projectName: "Forge Dev",
    });
    expect(crumbs.at(-1)?.label).toBe("Project API");
  });
});

describe("a project page's breadcrumb names the page", () => {
  const crumbOf = (sub: string) => {
    const pathname = `/projects/forge-dev${sub}`;
    const activeKey = buildActiveKey(pathname, "forge-dev");
    return buildCrumbs({ pathname, slug: "forge-dev", activeKey, projectName: "Forge Dev" }).at(-1)?.label;
  };

  it("reads Settings on the settings page", () => {
    expect(crumbOf("/settings")).toBe("Settings");
  });

  it.each(
    readdirSync(PROJECT_ROUTES).filter((d) => existsSync(join(PROJECT_ROUTES, d, "page.tsx"))),
  )("names /%s as something other than the dashboard", (dir) => {
    expect(crumbOf(`/${dir}`)).not.toBe("Dashboard");
  });

  it("names the Releases page under a version's own address", () => {
    expect(crumbOf("/releases/r1")).toBe("Releases");
  });

  it("names the Automation pages by their own names", () => {
    expect(crumbOf("/automation/schedules")).toBe("Schedules");
    expect(crumbOf("/automation/improvements")).toBe("Improvements");
  });

  it("reads Dashboard on the project's own page", () => {
    expect(crumbOf("")).toBe("Dashboard");
  });
});

describe("the project menu", () => {
  it("is Dashboard, Issues, Agents, Workflows, Automation and Releases, in that order", () => {
    expect(PROJECT_MENU.map((e) => e.label)).toEqual(["Dashboard", "Issues", "Agents", "Workflows", "Automation", "Releases"]);
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

  it("lights each Automation page and Releases, a version address included", () => {
    const at = (sub: string) => buildActiveKey(`/projects/forge-dev${sub}`, "forge-dev");
    expect(at("/automation/schedules")).toBe("proj-schedules");
    expect(at("/automation/improvements")).toBe("proj-improvements");
    expect(at("/releases")).toBe("proj-releases");
    expect(at("/releases/0.42.1")).toBe("proj-releases");
    expect(at("/workflows")).toBe("proj-workflows");
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
