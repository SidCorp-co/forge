// REQ-30 BC-6 (ISS-441): the snapshot each message carries names the record its page is about, for
// an issue, a requirement, a feedback item and a workflow design, so core can load it for the turn.
// Read at e523c4b0f it named only an issue, and the other three pages read as route "other".

import { uiSnapshotSchema } from "@forge/contracts/ui-actions";
import { describe, expect, it } from "vitest";
import { pageItemOf, uiSnapshotOf } from "./actions";

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
    expect(at("/projects/forge/requirements").route).toBe("other");
    expect(at("/projects/forge/requirements/not-a-key")).toMatchObject({ route: "other" });
    expect(at("/projects/forge/feedback/REQ-3").item).toBeUndefined();
    expect(at("/projects/forge/releases/v1").item).toBeUndefined();
    expect(pageItemOf("/requirements/%E0%A4%A")).toBeNull();
    expect(at("/settings").route).toBe("other");
  });
});
