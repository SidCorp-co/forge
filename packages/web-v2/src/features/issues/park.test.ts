import { describe, expect, it, vi } from "vitest";
import { parkAsksAQuestion, threadQuestionOf } from "./derive";
import { parkMenuItems, parkQueryKey } from "./park";
import type { IssuePark } from "./types";

const actions = () => ({ answer: vi.fn(), move: vi.fn(), notNeeded: vi.fn(), moveAnyway: vi.fn() });
const ordinary = [{ label: "Awaiting release" }];

function park(over: Partial<IssuePark> = {}): IssuePark {
  return {
    shape: "park",
    status: "needs_info",
    owes: "information",
    since: null,
    reason: null,
    resume: { at: null, why: "no record" },
    record: null,
    readings: [],
    openQuestionIds: [],
    ...over,
  };
}

describe("parkMenuItems — where the ordinary map stays the whole answer", () => {
  it("leaves a working rung alone while its park is being read, or reads nobody owes it", () => {
    for (const reading of [{ state: "loading" as const }, { state: "error" as const }, { state: "ready" as const, park: null }]) {
      expect(
        parkMenuItems({ status: "testing", reading, exits: undefined, ordinary, actions: actions() }),
      ).toBeNull();
    }
  });

  it("disables Move anyway where the map offers nothing from this rung", () => {
    const items = parkMenuItems({
      status: "waiting",
      reading: { state: "ready", park: park({ status: "waiting" }) },
      exits: {} as never,
      ordinary: [],
      actions: actions(),
    });
    expect(items?.at(-1)).toMatchObject({ label: "Move anyway…", disabled: true });
  });
});

describe("what counts as a question to answer", () => {
  it("is an open question row, whatever the rung", () => {
    expect(parkAsksAQuestion(park({ status: "waiting", openQuestionIds: ["q1"] }))).toBe(true);
    expect(threadQuestionOf(park({ openQuestionIds: ["q1"], reason: "asked" }))).toBeNull();
  });

  it("is a needs_info park's own words where no row carries them", () => {
    expect(threadQuestionOf(park({ reason: "Which tenant?" }))).toEqual({ prompt: "Which tenant?", readings: [] });
    expect(
      threadQuestionOf(
        park({ record: { commentId: "c", kind: "question", why: "Pick one", postedAt: "x" }, readings: ["A", "B"] }),
      ),
    ).toEqual({ prompt: "Pick one", readings: ["A", "B"] });
  });

  it("is nothing on a waiting park with no row, nor a needs_info park that said nothing", () => {
    expect(parkAsksAQuestion(park({ status: "waiting", reason: "look at the screen" }))).toBe(false);
    expect(parkAsksAQuestion(park())).toBe(false);
  });
});

describe("parkQueryKey", () => {
  it("sits under the issue's comments, so a new comment rereads the park, and moves with the status", () => {
    expect(parkQueryKey("i1", "waiting")).toEqual(["comments", "i1", "park", "waiting"]);
    expect(parkQueryKey("i1", "waiting")).not.toEqual(parkQueryKey("i1", "developed"));
  });
});
