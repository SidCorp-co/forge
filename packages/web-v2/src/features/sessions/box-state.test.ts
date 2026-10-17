// ISS-1228 r11 repair: one box read Idle on its session page and Offline on the sessions strip. Both read
// these now, and so does a device pill wherever no project line exists.

import { describe, expect, it } from "vitest";
import type { RunnerLine } from "@/features/project-dashboard/derive";
import { deviceStatusWord } from "@/features/runners/types";
import { boxHealth, boxWord } from "./box-state";

const line = (over: Partial<RunnerLine>): RunnerLine => ({
  id: "r1",
  deviceId: "d1",
  name: "bravo",
  platform: "linux",
  online: true,
  draining: false,
  busy: false,
  sessions: 0,
  running: 0,
  queued: 0,
  limit: null,
  activeIssueRef: null,
  activeStage: null,
  ...over,
});

describe("a box's state", () => {
  it.each([
    [{ online: false }, "Offline", "idle"],
    [{ online: false, sessions: 1 }, "Offline · 1 live session", "attention"],
    [{ online: true }, "Free · 0/1", "healthy"],
    [{ online: true, busy: true }, "Busy · 1/1", "healthy"],
    [{ online: false, draining: true }, "Draining", "idle"],
  ] as const)("%o reads %s", (over, word, dot) => {
    expect(boxWord(line(over), true)).toBe(word);
    expect(boxHealth(line(over), false)).toBe(dot);
  });

  it("says busy or free only once the activity is read", () => {
    expect(boxWord(line({ online: true }), false)).toBe("activity not read");
  });

  it("a busy box whose live session went quiet wants attention", () => {
    expect(boxHealth(line({ online: true, busy: true }), true)).toBe("attention");
  });

  it("never calls an offline device Idle", () => {
    expect(deviceStatusWord("offline")).toBe("Offline");
    expect(deviceStatusWord("online")).toBe("Online");
    expect(deviceStatusWord("revoked")).toBe("Revoked");
  });
});
