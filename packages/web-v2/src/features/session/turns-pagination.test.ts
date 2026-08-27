import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionApi } from "./api";
import { fetchAllTurns } from "./hooks";
import type { TurnRow } from "./types";

vi.mock("./api", () => ({ sessionApi: { getTurns: vi.fn() } }));

const turn = (id: string) => ({ id, turnIndex: 0 }) as TurnRow;
const getTurns = vi.mocked(sessionApi.getTurns);

describe("fetchAllTurns", () => {
  beforeEach(() => getTurns.mockReset());

  it("keeps asking until the server stops handing back a cursor", async () => {
    getTurns
      .mockResolvedValueOnce({ turns: [turn("a")], nextCursor: "a" })
      .mockResolvedValueOnce({ turns: [turn("b")], nextCursor: "b" })
      .mockResolvedValueOnce({ turns: [turn("c")], nextCursor: null });

    const res = await fetchAllTurns("s1");

    expect(res.turns.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(getTurns.mock.calls.map(([, o]) => o?.after)).toEqual([undefined, "a", "b"]);
  });

  it("stops on a server that never stops paging, rather than looping forever", async () => {
    getTurns.mockResolvedValue({ turns: [turn("x")], nextCursor: "x" });

    const res = await fetchAllTurns("s1");

    expect(getTurns).toHaveBeenCalledTimes(40);
    expect(res.nextCursor).toBeNull();
  });
});
