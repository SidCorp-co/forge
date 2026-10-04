import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWorkspaceCommands } from "./commands";

const APP = join(__dirname, "../../app/(workspace)");

function commands() {
  const push = vi.fn();
  const onNewChat = vi.fn();
  const list = buildWorkspaceCommands({
    router: { push },
    slug: "forge-dev",
    activeProjectName: "Forge",
    scopedProjects: [],
    pinnedIds: new Set(),
    pinnedViews: [],
    recents: [],
    toast: vi.fn(),
    onNewChat,
  });
  const routeOf = (label: string) => {
    push.mockReset();
    list.find((c) => c.label === label)?.onRun?.();
    return push.mock.calls[0]?.[0] as string | undefined;
  };
  return { list, push, onNewChat, routeOf };
}

describe("⌘K", () => {
  it("offers the project menu's destinations, Schedules and Improvements among them", () => {
    const { list, routeOf } = commands();
    const labels = list.map((c) => c.label);
    for (const page of ["Dashboard", "Requirements", "Workflows", "Issues", "Modules", "Agents / Runs", "Schedules", "Improvements", "Releases"]) {
      expect(labels).toContain(`Forge · ${page}`);
    }
    expect(routeOf("Forge · Schedules")).toBe("/projects/forge-dev/automation?tab=schedules");
    expect(routeOf("Forge · Improvements")).toBe("/projects/forge-dev/automation?tab=improvements");
    expect(routeOf("Forge · Automation")).toBe("/projects/forge-dev/automation");
    expect(routeOf("Forge · Contracts")).toBe("/projects/forge-dev/contracts");
    expect(routeOf("Forge · Requirements")).toBe("/projects/forge-dev/requirements");
    expect(routeOf("Forge · Modules")).toBe("/projects/forge-dev/modules");
  });

  it("offers nothing removed: no Library, Board, Insights, PM or Chat mode", () => {
    const { list } = commands();
    const text = list.map((c) => `${c.label} ${c.keywords ?? ""}`).join("\n");
    for (const gone of ["Library", "Board", "Insights", "· PM", "Go to Chat", "Go to Activity"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("routes every project destination it offers to a page that exists", () => {
    const { list, push } = commands();
    for (const c of list.filter((x) => x.label.startsWith("Forge · "))) {
      push.mockReset();
      c.onRun?.();
      const pushed = push.mock.calls[0]?.[0] as string;
      const href = pushed.split("?")[0] as string;
      const dir = href.replace("/projects/forge-dev", "/projects/[slug]");
      expect(existsSync(join(APP, dir, "page.tsx")), href).toBe(true);
    }
  });

  it("opens the chat dock for New chat instead of a route", () => {
    const { list, push, onNewChat } = commands();
    list.find((c) => c.label === "New chat")?.onRun?.();
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });
});
