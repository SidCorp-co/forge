// REQ-30 BC-6 (ISS-441): the snapshot each message carries names the record its page is about, for
// an issue, a requirement, a feedback item and a workflow design, so core can load it for the turn.
// Read at e523c4b0f it named only an issue, and the other three pages read as route "other".

import { parseUiAction, UI_ACTION_NAMES, uiSnapshotSchema } from "@forge/contracts/ui-actions";
import { describe, expect, it, vi } from "vitest";
import { applyUiAction, pageItemOf, type UiActionEnv, uiSnapshotOf } from "./actions";

const at = (pathname: string) => uiSnapshotOf({ pathname, search: "", userId: null, selection: [] });

describe("the page snapshot names the record its page is about", () => {
  for (const [segment, key, kind] of [
    ["requirements", "REQ-30", "requirement"],
    ["feedback", "FB-12", "feedback"],
    ["workflows", "chat-turn", "workflow"],
    ["issues", "ISS-441", "issue"],
  ] as const) {
    it(`reads /${segment}/${key} as ${kind} ${key}, in a shape core takes`, () => {
      const snapshot = at(`/projects/forge/${segment}/${key}`);
      expect(snapshot).toMatchObject({ route: kind, item: { kind, key } });
      expect(uiSnapshotSchema.safeParse(snapshot).success).toBe(true);
    });
  }

  it("reads an encoded key as the page does", () => {
    expect(at("/projects/forge/workflows/feedback-lifecycle").item).toEqual({ kind: "workflow", key: "feedback-lifecycle" });
    expect(pageItemOf("/requirements/REQ%2D30")).toEqual({ kind: "requirement", key: "REQ-30" });
  });

  it("names no record on a list, on a page about none, or for a key its kind does not take", () => {
    expect(at("/projects/forge/issues").item).toBeUndefined();
    expect(at("/projects/forge/issues").route).toBe("issues");
    expect(at("/projects/forge/requirements").route).toBe("requirements");
    expect(at("/projects/forge/requirements").item).toBeUndefined();
    expect(at("/projects/forge/requirements/not-a-key")).toMatchObject({ route: "other" });
    expect(at("/projects/forge/feedback/REQ-3").item).toBeUndefined();
    expect(at("/projects/forge/releases/v1").item).toBeUndefined();
    expect(pageItemOf("/requirements/%E0%A4%A")).toBeNull();
    expect(at("/settings").route).toBe("other");
  });
});

// REQ-41 BC-9: a page action from chat changes only the view. Every action the registry holds is
// applied here with the network watched: none sends a request, each moves only the URL, the list
// selection, the highlight or the board, and an act on a record is left to a button the person presses.
describe("every page action changes only the view (BC-9)", () => {
  const SAMPLES: Record<(typeof UI_ACTION_NAMES)[number], unknown> = {
    "ui.navigate": { route: "requirements" },
    "ui.issues.filter": { mode: "merge", set: { waitingOn: "you" } },
    "ui.requirements.filter": { mode: "replace", set: { waitingOn: "agent", state: ["agreed"] } },
    "ui.feedback.filter": { mode: "merge", set: { phase: ["new"] } },
    "ui.workflows.filter": { mode: "merge", set: { text: "chat" } },
    "ui.releases.filter": { mode: "merge", set: { waitingOn: "running" } },
    "ui.select": { keys: [] },
    "ui.open": { key: "REQ-34" },
    "ui.highlight": { target: "row", key: "REQ-34" },
    "ui.board.draw": { doc: { v: "wireframe-v1", title: "Sign in", shapes: [{ type: "frame", id: "f", x: 0, y: 0, w: 100, h: 100, label: "Sign in" }] } },
    "ui.board.revise": { ops: [{ op: "update", id: "f", set: { x: 10 } }] },
  };

  it("sends no request for any of them", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const moved: string[] = [];
    let href = "/projects/demo/requirements";
    const env: UiActionEnv = {
      t: (k) => k,
      language: "en",
      slug: "demo",
      userId: "u-me",
      href: () => href,
      go: (h) => {
        moved.push(h);
        href = h;
      },
      selection: () => ({ rows: () => [], selectedKeys: () => [], setSelectedIds: () => {} }),
      find: () => document.body,
      mark: () => {},
      unmark: () => {},
    };
    for (const name of UI_ACTION_NAMES) {
      const parsed = parseUiAction(name, SAMPLES[name]);
      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) continue;
      const outcome = applyUiAction(parsed.action, env);
      expect(outcome.ok, `${name}: ${outcome.ok ? "" : outcome.message}`).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(moved.every((h) => h.startsWith("/projects/demo/"))).toBe(true);
    vi.unstubAllGlobals();
  });
});
