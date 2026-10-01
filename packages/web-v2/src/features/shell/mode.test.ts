import { describe, expect, it } from "vitest";
import {
  NO_MODE_ROUTES,
  chatConversationId,
  chatPath,
  chatSlug,
  modeOf,
  rememberRoute,
  routeSlug,
  switchTarget,
} from "./mode";

describe("the mode follows the route", () => {
  it.each([
    ["/chat", "chat"],
    ["/chat/forge-dev", "chat"],
    ["/chat/forge-dev/0b6f", "chat"],
    ["/", "activity"],
    ["/projects/forge-dev/issues", "activity"],
    ["/chatter", "activity"],
    ["/projects/chat", "activity"],
  ])("%s is %s", (path, mode) => {
    expect(modeOf(path)).toBe(mode);
  });

  it("reads the project and the conversation off a chat route", () => {
    expect(chatSlug("/chat/forge-dev/c-1")).toBe("forge-dev");
    expect(chatConversationId("/chat/forge-dev/c-1")).toBe("c-1");
    expect(chatSlug("/chat")).toBeNull();
    expect(routeSlug("/chat/forge-dev")).toBe("forge-dev");
    expect(routeSlug("/projects/forge-dev/issues")).toBe("forge-dev");
    expect(chatPath("forge-dev", "c-1")).toBe("/chat/forge-dev/c-1");
  });
});

describe("each mode remembers its last route", () => {
  it("files a visited route under its own mode and leaves the other mode's alone", () => {
    let routes = rememberRoute(NO_MODE_ROUTES, "/projects/forge-dev/issues?filter=open");
    routes = rememberRoute(routes, "/chat/forge-dev/c-1");
    routes = rememberRoute(routes, "/runners");
    expect(routes).toEqual({ activity: "/runners", chat: "/chat/forge-dev/c-1" });
  });

  it("switches back onto the remembered route, query and all", () => {
    expect(switchTarget("activity", "/projects/forge-dev/issues?filter=open", "forge-dev")).toBe(
      "/projects/forge-dev/issues?filter=open",
    );
    expect(switchTarget("chat", "/chat/forge-dev/c-1", "forge-dev")).toBe("/chat/forge-dev/c-1");
  });

  it("opens a mode with nothing remembered on its root", () => {
    expect(switchTarget("chat", null, null)).toBe("/chat");
    expect(switchTarget("activity", null, null)).toBe("/");
  });

  it("never takes a route remembered for the other mode", () => {
    expect(switchTarget("chat", "/runners", null)).toBe("/chat");
  });
});

describe("switching modes keeps the selected project", () => {
  it("opens Chat in the project selected in Activity", () => {
    expect(switchTarget("chat", null, "forge-dev")).toBe("/chat/forge-dev");
    expect(switchTarget("chat", "/chat/other/c-9", "forge-dev")).toBe("/chat/forge-dev");
  });

  it("moves a remembered Activity page onto the project selected in Chat, dropping the record that was open", () => {
    expect(switchTarget("activity", "/projects/other/issues/ISS-3", "forge-dev")).toBe(
      "/projects/forge-dev/issues",
    );
    expect(switchTarget("activity", "/projects/other", "forge-dev")).toBe("/projects/forge-dev");
    expect(switchTarget("activity", null, "forge-dev")).toBe("/projects/forge-dev");
  });

  it("keeps a workspace page, which carries no project of its own", () => {
    expect(switchTarget("activity", "/runners", "forge-dev")).toBe("/runners");
  });
});
