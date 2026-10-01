import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ECOSYSTEM_ITEMS, buildActiveKey, buildCrumbs } from "./nav-model";

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
