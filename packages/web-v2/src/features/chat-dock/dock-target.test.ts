// ISS-277 (FB-88): with nothing picked, Ask Agent opens on the project's latest live conversation,
// not a new chat: the page's own rooms first, then the project's, a room waiting on the person before
// a newer one that is not, and a draft only when the project has none.

import { describe, expect, it } from "vitest";
import { type DockRoom, openingTarget, targetInScope, waitingRoom } from "./dock-target";

let at = 0;
function room(id: string, over: Partial<DockRoom> = {}): DockRoom {
  at += 1;
  return {
    id,
    projectId: "p1",
    updatedAt: `2026-10-06T16:${String(at).padStart(2, "0")}:00Z`,
    archivedAt: null,
    subjectKey: null,
    threadStatus: "done",
    ...over,
  };
}

const opening = (rows: DockRoom[], pageKey: string | null = null) =>
  openingTarget(rows, { projectId: "p1", pageKey });

describe("targetInScope", () => {
  it("answers the project's latest conversation, not a draft, when nothing is picked", () => {
    expect(targetInScope(null, "p1")).toEqual({ kind: "latest", projectId: "p1" });
  });

  it("answers the new project's latest when the pick belongs to another project", () => {
    const other = { kind: "room", projectId: "p0", conversationId: "c0" } as const;
    expect(targetInScope(other, "p1")).toEqual({ kind: "latest", projectId: "p1" });
  });

  it("keeps an explicit pick in this project, a new draft included", () => {
    const draft = { kind: "draft", projectId: "p1" } as const;
    expect(targetInScope(draft, "p1")).toBe(draft);
    expect(targetInScope(null, null)).toBeNull();
  });
});

describe("openingTarget", () => {
  it("opens the newest live room in the project", () => {
    const rows = [room("older"), room("newest"), room("archived", { archivedAt: "2026-10-06T17:00:00Z" })];
    expect(opening(rows)).toEqual({ kind: "room", projectId: "p1", conversationId: "newest" });
  });

  it("opens a room waiting on the person before a newer one that is not", () => {
    const rows = [room("asked", { threadStatus: "waiting_on_you" }), room("newer")];
    expect(opening(rows)).toMatchObject({ conversationId: "asked" });
  });

  it("opens a room about the page's record before the project's", () => {
    const rows = [room("about-req", { subjectKey: "REQ-1" }), room("project", { threadStatus: "waiting_on_you" })];
    expect(opening(rows, "REQ-1")).toMatchObject({ conversationId: "about-req" });
    expect(opening(rows, "REQ-9")).toMatchObject({ conversationId: "project" });
  });

  it("ignores another project's rooms, and drafts only when the project has no live room", () => {
    expect(opening([room("elsewhere", { projectId: "p2" })])).toEqual({ kind: "draft", projectId: "p1" });
    expect(opening([])).toEqual({ kind: "draft", projectId: "p1" });
  });
});

describe("waitingRoom", () => {
  it("names the newest room waiting on the person that is not the one open", () => {
    const rows = [room("a", { threadStatus: "waiting_on_you" }), room("b", { threadStatus: "waiting_on_you" }), room("c")];
    expect(waitingRoom(rows, { projectId: "p1", openId: null })?.id).toBe("b");
    expect(waitingRoom(rows, { projectId: "p1", openId: "b" })?.id).toBe("a");
  });

  it("names none when nothing waits, or only another project's or an archived room does", () => {
    const rows = [
      room("done"),
      room("elsewhere", { projectId: "p2", threadStatus: "waiting_on_you" }),
      room("archived", { threadStatus: "waiting_on_you", archivedAt: "2026-10-06T17:00:00Z" }),
    ];
    expect(waitingRoom(rows, { projectId: "p1", openId: null })).toBeNull();
  });
});
