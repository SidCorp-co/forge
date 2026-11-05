// ISS-1006, the owner's dock: the header read "Done" while the thread under it read "Responding…". The
// header and the thread read one fact now: while the thread draws its turn working or writing, the
// header reads In progress, and it wears the room's stored status only once no turn is drawn running.
// Planted red by handing ThreadSub the stored status again.
//
// @direct-test-of packages/web-v2/src/features/conversations/room-status.ts
// @direct-test-of packages/web-v2/src/features/conversations/components/conversation-room-parts.tsx

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ConversationListItem } from "./types";
import { RoomHeader } from "./components/conversation-room-parts";
import { roomStatusOf } from "./room-status";

const room = { id: "c1", title: "What do I approve here?", kind: null, threadStatus: "done" } as unknown as ConversationListItem;

const header = (stage: Parameters<typeof roomStatusOf>[1]) =>
  renderWithQuery(<RoomHeader room={room} firstSaid={undefined} projectId="p1" onMembers={() => {}} actions={null} stage={stage} />);

describe("the room's header and its thread never disagree", () => {
  it("reads In progress, never Done, while the thread writes its answer", () => {
    header("responding");
    const sub = screen.getByTestId("thread-sub");
    expect(sub.textContent).toContain("In progress");
    expect(sub.textContent).not.toContain("Done");
  });

  it("reads In progress while the turn works", () => {
    expect(roomStatusOf("done", "working")).toBe("in_progress");
    expect(roomStatusOf("waiting_on_you", "responding")).toBe("in_progress");
  });

  it("reads the stored status once no turn is drawn running, so Done stands only over a settled thread", () => {
    header(null);
    expect(screen.getByTestId("thread-sub").textContent).toContain("Done");
    expect(roomStatusOf("done", "failed")).toBe("done");
    expect(roomStatusOf(null, null)).toBeNull();
  });
});
