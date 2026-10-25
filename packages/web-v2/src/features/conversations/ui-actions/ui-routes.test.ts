// REQ-69 BC-1: chat opens any list by name. Every route `ui.navigate` may name is a page the web
// serves, read off the router's own route files, so a route naming a page nobody draws (dev.304:
// schedules at /automation/schedules, improvements, and ecosystem at /ecosystem, none with an index)
// fails here rather than taking the person to a blank screen. Each page whose view the URL holds has
// its filter.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { UI_LIST_FILTER_ACTIONS, UI_PRODUCT_LISTS, UI_ROUTES, parseUiAction } from "@forge/contracts/ui-actions";
import { describe, expect, it } from "vitest";

const PROJECT_ROUTES = join(import.meta.dirname, "../../../routes/_workspace/projects/$slug");

describe("every route the chat may open", () => {
  it("is a page the router serves", () => {
    const missing = Object.entries(UI_ROUTES).filter(([, path]) => !existsSync(join(PROJECT_ROUTES, path, "index.tsx")));
    expect(missing).toEqual([]);
  });

  it("includes the pages REQ-69 names, and no page REQ-33 removed", () => {
    expect(Object.keys(UI_ROUTES)).toEqual(expect.arrayContaining(["approvals", "status", "contracts", "modules", "agents", "automation"]));
    expect(Object.keys(UI_ROUTES)).not.toContain("memory");
    expect(Object.keys(UI_ROUTES)).not.toContain("decisions");
  });

  it("has a filter for each page whose view the URL holds, opening that page", () => {
    for (const list of UI_PRODUCT_LISTS) expect(UI_ROUTES[list], list).toBeDefined();
    const topic = parseUiAction("ui_approvals_filter", { mode: "merge", set: [{ field: "topic", value: "mockup" }] });
    expect(topic).toMatchObject({ ok: true, action: { name: UI_LIST_FILTER_ACTIONS.approvals, params: { set: { topic: "mockup" } } } });
    const days = parseUiAction("ui_status_filter", { mode: "merge", set: { days: "30" } });
    expect(days).toMatchObject({ ok: true, action: { params: { set: { days: "30" } } } });
  });

  it("refuses a value the page does not have, by name", () => {
    const tab = parseUiAction("ui_automation_filter", { mode: "merge", set: [{ field: "tab", value: "improvements" }] });
    expect(tab).toMatchObject({ ok: false, code: "UI_ACTION_INVALID" });
    expect(tab.ok ? "" : tab.message).toMatch(/set\.0\.value/);
    expect(parseUiAction("ui_navigate", { route: "schedules" })).toMatchObject({ ok: false, code: "UI_ACTION_INVALID" });
  });
});
