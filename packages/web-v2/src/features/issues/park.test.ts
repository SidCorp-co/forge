import { describe, expect, it, vi } from "vitest";
import { parkAsksAQuestion, threadQuestionOf } from "./derive";
import {
  ANSWER_LABEL,
  MOVE_ANYWAY_LABEL,
  NO_RUNG_LABEL,
  NOT_NEEDED_LABEL,
  PARK_ERROR_LABEL,
  PARK_LOADING_LABEL,
  parkMenuItems,
  parkQueryKey,
} from "./park";
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
    answer: null,
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

  it("is a needs_info park's own words where no row carries them, the sentence it stopped with first", () => {
    expect(threadQuestionOf(park({ reason: "Which tenant?" }))).toEqual({
      prompt: "Which tenant?",
      why: null,
      readings: [],
      answer: null,
    });
    expect(
      threadQuestionOf(
        park({
          reason: "Should the export keep the legacy column order?",
          record: { commentId: "c", kind: "question", why: "the export order is not stated", postedAt: "x" },
          readings: ["keep -> the legacy order stays", "B"],
        }),
      ),
    ).toEqual({
      prompt: "Should the export keep the legacy column order?",
      why: "the export order is not stated",
      readings: [
        { choice: "keep", outcome: "the legacy order stays" },
        { choice: "B", outcome: null },
      ],
      answer: null,
    });
    expect(
      threadQuestionOf(park({ record: { commentId: "c", kind: "question", why: "Pick one", postedAt: "x" } }))
        ?.prompt,
    ).toBe("Pick one");
  });

  it("is answered once a person replied in the thread, and then nothing is left to answer", () => {
    const answered = park({
      reason: "Which tenant?",
      answer: { commentId: "a1", postedAt: "2026-09-30T00:00:00.000Z", text: "tenant B" },
    });
    expect(threadQuestionOf(answered)?.answer?.text).toBe("tenant B");
    expect(parkAsksAQuestion(answered)).toBe(false);
  });

  it("leads with Resume and offers no Answer once the thread question is answered", () => {
    const items = parkMenuItems({
      status: "needs_info",
      reading: {
        state: "ready",
        park: park({
          reason: "Which tenant?",
          resume: { at: "in_progress", recordId: "r" },
          answer: { commentId: "a1", postedAt: "2026-09-30T00:00:00.000Z", text: "tenant B" },
        }),
      },
      exits: { needs_info: ["open", "in_progress", "on_hold", "dropped"] } as never,
      ordinary: [],
      actions: actions(),
    });
    const labels = items?.map((i) => i.label) ?? [];
    expect(labels[0]).toBe("Resume at In progress");
    expect(labels).not.toContain("Answer the question");
    expect(labels).not.toContain("The question is not needed any more…");
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

describe("the menu's own words", () => {
  it("say none of the kernel's — park, rung, decision round", () => {
    for (const label of [ANSWER_LABEL, NOT_NEEDED_LABEL, MOVE_ANYWAY_LABEL, NO_RUNG_LABEL, PARK_LOADING_LABEL, PARK_ERROR_LABEL]) {
      expect(label).not.toMatch(/\b(park|parked|rung|decision round)\b/i);
    }
  });
});
