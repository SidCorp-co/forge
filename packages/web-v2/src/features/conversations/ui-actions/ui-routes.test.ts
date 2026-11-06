// REQ-69 BC-1: chat opens any list by name. Every route `ui.navigate` may name is a page the web
// serves, read off the router's own route files, so a route naming a page nobody draws (dev.537:
// schedules at /automation/schedules, improvements at /automation/improvements, and ecosystem at
// /ecosystem, none with an index) fails here rather than taking the person to a blank screen.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseUiAction, UI_PRODUCT_LISTS, UI_ROUTES } from "@forge/contracts/ui-actions";
import { describe, expect, it } from "vitest";

const PROJECT_ROUTES = join(import.meta.dirname, "../../../routes/_workspace/projects/$slug");

describe("every route the chat may open", () => {
  it("is a page the router serves", () => {
    const missing = Object.entries(UI_ROUTES).filter(([, path]) => !existsSync(join(PROJECT_ROUTES, path, "index.tsx")));
    expect(missing).toEqual([]);
  });

  it("includes the pages REQ-69 names, and no page moved into another", () => {
    expect(Object.keys(UI_ROUTES)).toEqual(
      expect.arrayContaining(["approvals", "status", "contracts", "modules", "agents", "automation", "channels"]),
    );
    for (const moved of ["memory", "decisions", "lessons", "roadmap", "questions"]) expect(Object.keys(UI_ROUTES)).not.toContain(moved);
  });

  it("names a page for each list the chat filters", () => {
    for (const list of UI_PRODUCT_LISTS) expect(UI_ROUTES[list], list).toBeDefined();
  });

  it("opens a page by name, and refuses one the web does not serve by name", () => {
    expect(parseUiAction("ui_navigate", { route: "approvals" })).toMatchObject({ ok: true });
    expect(parseUiAction("ui_navigate", { route: "schedules" })).toMatchObject({ ok: false, code: "UI_ACTION_INVALID" });
  });
});
