import { describe, expect, it } from "vitest";
import { orderByOwner } from "./session-tree";

type Row = { id: string; parentSessionId?: string | null };
const ids = (rows: Array<{ row: Row }>) => rows.map((r) => r.row.id);

describe("orderByOwner", () => {
  it("puts each session under the one that owns it", () => {
    const rows: Row[] = [
      { id: "master", parentSessionId: null },
      { id: "run-a", parentSessionId: "master" },
      { id: "run-b", parentSessionId: "master" },
    ];
    const out = orderByOwner(rows);
    expect(ids(out)).toEqual(["master", "run-a", "run-b"]);
    expect(out.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(out[0]?.hasChildren).toBe(true);
    expect(out[1]?.hasChildren).toBe(false);
  });

  it("nests a grandchild one level deeper again", () => {
    const rows: Row[] = [
      { id: "master", parentSessionId: null },
      { id: "run", parentSessionId: "master" },
      { id: "step", parentSessionId: "run" },
    ];
    expect(orderByOwner(rows).map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("keeps the order the caller sorted siblings into", () => {
    const rows: Row[] = [
      { id: "m", parentSessionId: null },
      { id: "newest", parentSessionId: "m" },
      { id: "older", parentSessionId: "m" },
      { id: "oldest", parentSessionId: "m" },
    ];
    expect(ids(orderByOwner(rows))).toEqual(["m", "newest", "older", "oldest"]);
  });

  it("shows a session whose owner is not in this list, rather than hiding it", () => {
    // The parent exists in the database but a filter excluded it. A row that
    // vanishes because of something NOT in the list is worse than a flat one.
    const rows: Row[] = [{ id: "run", parentSessionId: "a-master-not-shown" }];
    const out = orderByOwner(rows);
    expect(ids(out)).toEqual(["run"]);
    expect(out[0]?.depth).toBe(0);
  });

  it("places every row exactly once when the owner edge has a cycle", () => {
    const rows: Row[] = [
      { id: "a", parentSessionId: "b" },
      { id: "b", parentSessionId: "a" },
      { id: "c", parentSessionId: null },
    ];
    const out = orderByOwner(rows);
    expect(ids(out).sort()).toEqual(["a", "b", "c"]);
    expect(new Set(ids(out)).size).toBe(3);
  });

  it("treats a row that names itself as a root", () => {
    const rows: Row[] = [{ id: "self", parentSessionId: "self" }];
    expect(orderByOwner(rows)[0]?.depth).toBe(0);
  });

  it("stops indenting past the depth the index renders", () => {
    const rows: Row[] = [{ id: "r0", parentSessionId: null }];
    for (let i = 1; i <= 8; i += 1) rows.push({ id: `r${i}`, parentSessionId: `r${i - 1}` });
    const depths = orderByOwner(rows).map((r) => r.depth);
    expect(Math.max(...depths)).toBe(4);
    expect(depths).toHaveLength(9);
  });

  it("answers an empty list with an empty list", () => {
    expect(orderByOwner([])).toEqual([]);
  });
});
