// ISS-1229 r24, the master's ruling on judge-70's finding: with two unnamed people in a room, the
// question before taking one out named both "another member". People who read alike are told apart
// by when each was added — the day, then the minute, then the order — in the list and the question
// in the same words.

import { describe, expect, it } from "vitest";
import { memberName, removalClaim, removalQuestion } from "./membership";
import type { ConversationParticipant } from "./types";

const person = (id: string, userId: string, addedAt: string, displayName = "Another member"): ConversationParticipant => ({
  id,
  kind: "person",
  userId,
  projectId: null,
  label: null,
  displayName,
  reachable: null,
  addedAt,
});

const roomOf = (...participants: ConversationParticipant[]) => ({ participants, scopeProjects: [] });

describe("two people who read the same name", () => {
  it("are told apart by the day each was added", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z");
    const b = person("pb", "u3", "2026-10-04T09:15:00Z");
    const room = roomOf(a, b);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026)");
    expect(memberName(b, "me", "start", room)).toBe("Another member (added 4 Oct 2026)");
    expect(removalQuestion(a, "me", room).title).toBe("Take another member (added 3 Oct 2026) out of this room?");
    expect(removalClaim(b, room, "me")).toBe("Another member (added 4 Oct 2026) will no longer be listed in this room.");
  });

  it("are told apart by the minute where the day is the same", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z");
    const b = person("pb", "u3", "2026-10-03T14:05:00Z");
    const room = roomOf(a, b);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 09:15 UTC)");
    expect(removalQuestion(b, "me", room).title).toBe("Take another member (added 3 Oct 2026, 14:05 UTC) out of this room?");
  });

  it("are told apart by the order they were added where the minute is the same too", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:10Z");
    const b = person("pb", "u3", "2026-10-03T09:15:40Z");
    const room = roomOf(b, a);
    expect(memberName(a, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 09:15 UTC, the first)");
    expect(memberName(b, "me", "start", room)).toBe("Another member (added 3 Oct 2026, 09:15 UTC, the second)");
    expect(removalQuestion(b, "me", room).title).toBe(
      "Take another member (added 3 Oct 2026, 09:15 UTC, the second) out of this room?",
    );
    // The button answers that question, so it keeps the short name and fits a phone's width.
    expect(removalQuestion(b, "me", room).confirm).toBe("Take another member out");
  });

  it("leaves a name nobody else in the room reads alone, and the reader as You", () => {
    const a = person("pa", "u2", "2026-10-03T09:15:00Z", "Mai Tran");
    const b = person("pb", "u3", "2026-10-04T09:15:00Z");
    const me = person("pm", "me", "2026-10-03T09:15:00Z");
    const room = roomOf(a, b, me);
    expect(memberName(a, "me", "start", room)).toBe("Mai Tran");
    expect(memberName(b, "me", "start", room)).toBe("Another member");
    expect(memberName(me, "me", "start", room)).toBe("You");
  });
});
