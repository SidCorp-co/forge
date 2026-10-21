// ISS-1229 r28, judge-80: lists of people followed address order, so the reader came third on the
// organization page, and a room's people list put "the second" above "You" and "the first" below.

import { describe, expect, it } from "vitest";
import { addedApart, orderPeople, type ListedPerson } from "./order-people";

const person = (userId: string, displayName: string | null, addedAt: string): ListedPerson => ({
  userId,
  displayName,
  addedAt,
});

describe("the order of a list of people", () => {
  it("leads with the reader, then names in order, then the unnamed by when each was added", () => {
    const listed = [
      person("u-late", null, "2026-10-03T10:00:00Z"),
      person("u-zed", "Zed", "2026-10-01T09:00:00Z"),
      person("me", null, "2026-10-04T09:00:00Z"),
      person("u-early", null, "2026-10-02T10:00:00Z"),
      person("u-an", "an Nguyen", "2026-10-05T09:00:00Z"),
    ];
    expect(orderPeople(listed, "me").map((p) => p.userId)).toEqual(["me", "u-an", "u-zed", "u-early", "u-late"]);
  });

  it("orders rows of any shape through the mapping it is given", () => {
    const rows = [
      { id: "b", name: null, joined: "2026-10-02T00:00:00Z" },
      { id: "a", name: null, joined: "2026-10-01T00:00:00Z" },
    ];
    const ordered = orderPeople(rows, null, (r) => ({ userId: r.id, displayName: r.name, addedAt: r.joined }));
    expect(ordered.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("what tells two unnamed people apart", () => {
  it("is the day each was added, then the minute, then their place", () => {
    const days = [person("a", null, "2026-10-01T09:00:00Z"), person("b", null, "2026-10-03T09:00:00Z")];
    expect(addedApart(days[0] as ListedPerson, days)).toMatch(/^added 1 Oct 2026$/);
    const minutes = [person("a", null, "2026-10-01T09:00:00Z"), person("b", null, "2026-10-01T09:05:00Z")];
    expect(addedApart(minutes[1] as ListedPerson, minutes)).toMatch(/^added 1 Oct 2026, \d\d:\d\d$/);
    const same = [person("b", null, "2026-10-01T09:00:10Z"), person("a", null, "2026-10-01T09:00:20Z")];
    expect(addedApart(same[1] as ListedPerson, same)).toMatch(/, the second$/);
  });

  it("is nothing where nobody else reads alike, the reader included", () => {
    const listed = [person("me", null, "2026-10-01T09:00:00Z"), person("u", null, "2026-10-02T09:00:00Z")];
    expect(addedApart(listed[1] as ListedPerson, listed, "me")).toBeNull();
    expect(addedApart(person("x", null, ""), listed)).toBeNull();
  });
});
