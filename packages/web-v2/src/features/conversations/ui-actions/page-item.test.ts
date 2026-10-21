// REQ-49 BC-4: a mockup can be the subject of a chat in the Ask Agent panel. While one is named on its
// item's page (`?mockup=MK-n`, set when it opens full screen and kept when the chat is asked about it),
// the snapshot every message carries names the mockup as the page's item, which core loads for the turn.

import { describe, expect, it } from "vitest";
import { uiSnapshotOf } from "./actions";

const snap = (pathname: string, search = "") => uiSnapshotOf({ pathname, search, userId: "u1", selection: [] });

describe("the page item while a mockup is named", () => {
  it("is the mockup on a requirement, a feedback item or an issue page", () => {
    for (const path of ["/projects/acme/requirements/REQ-4", "/projects/acme/feedback/FB-2", "/projects/acme/issues/ISS-9"]) {
      expect(snap(path, "?mockup=MK-3&full=1"), path).toMatchObject({ route: "mockup", item: { kind: "mockup", key: "MK-3" } });
    }
  });

  it("stays the record itself without one, or with a key that names no mockup", () => {
    expect(snap("/projects/acme/requirements/REQ-4").item).toEqual({ kind: "requirement", key: "REQ-4" });
    expect(snap("/projects/acme/requirements/REQ-4", "?mockup=REQ-4").item).toEqual({ kind: "requirement", key: "REQ-4" });
  });

  it("is never a mockup on a page that does not hold one", () => {
    expect(snap("/projects/acme/workflows/chat-turn", "?mockup=MK-3").item).toEqual({ kind: "workflow", key: "chat-turn" });
    expect(snap("/projects/acme/issues", "?mockup=MK-3").item).toBeUndefined();
  });
});
