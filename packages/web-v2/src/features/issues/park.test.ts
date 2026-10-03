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
  it("leaves a working status alone while its park is being read, or reads nobody owes it", () => {
    for (const reading of [{ state: "loading" as const }, { state: "error" as const }, { state: "ready" as const, park: null }]) {
      expect(
        parkMenuItems({ status: "in_progress", reading, exits: undefined, ordinary, actions: actions() }),
      ).toBeNull();
    }
  });

  it("leaves on_hold to its own exits: a deliberate pause owes nobody an answer", () => {
    for (const reading of [{ state: "loading" as const }, { state: "error" as const }, { state: "ready" as const, park: null }]) {
      expect(
        parkMenuItems({ status: "on_hold", reading, exits: undefined, ordinary, actions: actions() }),
      ).toBeNull();
    }
  });

  it("says needs_info's park is being read rather than offering a resume it cannot back", () => {
    const items = parkMenuItems({
      status: "needs_info",
      reading: { state: "loading" },
      exits: undefined,
      ordinary,
      actions: actions(),
    });
    expect(items?.[0]).toMatchObject({ label: PARK_LOADING_LABEL, disabled: true });
  });

  it("disables Move anyway where the map offers nothing from this status", () => {
    const items = parkMenuItems({
      status: "needs_info",
      reading: { state: "ready", park: park() },
      exits: {} as never,
      ordinary: [],
      actions: actions(),
    });
    expect(items?.at(-1)).toMatchObject({ label: "Move anyway…", disabled: true });
  });
});

describe("what counts as a question to answer", () => {
  it("is an open question row, whatever the status", () => {
    expect(parkAsksAQuestion(park({ shape: "question", status: "in_progress", openQuestionIds: ["q1"] }))).toBe(true);
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
          record: { commentId: "c", eventId: null, kind: "question", why: "the export order is not stated", postedAt: "x" },
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
      threadQuestionOf(park({ record: { commentId: "c", eventId: null, kind: "question", why: "Pick one", postedAt: "x" } }))
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
          resume: { at: "in_progress", recordId: null },
          answer: { commentId: "a1", postedAt: "2026-09-30T00:00:00.000Z", text: "tenant B" },
        }),
      },
      exits: { needs_info: ["in_progress", "on_hold", "dropped"] } as never,
      ordinary: [],
      actions: actions(),
    });
    const labels = items?.map((i) => i.label) ?? [];
    expect(labels[0]).toBe("Resume at In progress");
    expect(labels).not.toContain("Answer the question");
    expect(labels).not.toContain("The question is not needed any more…");
  });

  it("is nothing on a working status's reading with no row, nor a needs_info park that said nothing", () => {
    expect(parkAsksAQuestion(park({ shape: "question", status: "in_progress", reason: "look at the screen" }))).toBe(false);
    expect(parkAsksAQuestion(park())).toBe(false);
  });
});

describe("parkQueryKey", () => {
  it("sits under the issue's comments, so a new comment rereads the park, and moves with the status", () => {
    expect(parkQueryKey("i1", "needs_info")).toEqual(["comments", "i1", "park", "needs_info"]);
    expect(parkQueryKey("i1", "needs_info")).not.toEqual(parkQueryKey("i1", "in_progress"));
  });
});

describe("the menu's own words", () => {
  it("say none of the kernel's — park, rung, decision round", () => {
    for (const label of [ANSWER_LABEL, NOT_NEEDED_LABEL, MOVE_ANYWAY_LABEL, NO_RUNG_LABEL, PARK_LOADING_LABEL, PARK_ERROR_LABEL]) {
      expect(label).not.toMatch(/\b(park|parked|rung|decision round)\b/i);
    }
  });
});
