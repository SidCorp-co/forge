import { describe, expect, it } from "vitest";
import {
  HEALTH_KEY_TONE,
  HEALTH_META,
  STATUS_KEY_TONE,
  STATUS_META,
  type SemanticTone,
  type StatusKey,
  TONE_META,
} from "./status";

const TONES: SemanticTone[] = [
  "success",
  "failure",
  "active",
  "attention",
  "blocked",
  "neutral",
  "infra",
];

const STATUS_KEYS: StatusKey[] = [
  "running",
  "queued",
  "blocked",
  "waiting",
  "passed",
  "failed",
  "paused",
  "done",
  "review",
  "zombie",
  "swept",
];

describe("TONE_META — the single source of truth", () => {
  it("defines one fg/bg/dot token for every semantic tone", () => {
    for (const tone of TONES) {
      const m = TONE_META[tone];
      expect(m, tone).toBeDefined();
      expect(m.fg, tone).toMatch(/^var\(--/);
      expect(m.bg, tone).toMatch(/^var\(--/);
      expect(m.dot, tone).toMatch(/^var\(--/);
    }
  });

  it("uses red ONLY for the failure tone", () => {
    for (const tone of TONES) {
      const usesRed = [TONE_META[tone].fg, TONE_META[tone].bg, TONE_META[tone].dot].some((t) =>
        t.includes("red"),
      );
      expect(usesRed, tone).toBe(tone === "failure");
    }
  });
});

describe("STATUS_META derives from TONE_META", () => {
  it("maps every StatusKey to its tone's colors", () => {
    for (const key of STATUS_KEYS) {
      const tone = TONE_META[STATUS_KEY_TONE[key]];
      expect(STATUS_META[key].fg, key).toBe(tone.fg);
      expect(STATUS_META[key].bg, key).toBe(tone.bg);
      expect(STATUS_META[key].dot, key).toBe(tone.dot);
      expect(STATUS_META[key].label, key).toBeTruthy();
    }
  });

  it("keeps red strictly for genuine failures — never a benign/idle key", () => {
    // The benign/blocked/idle vocabulary must NOT resolve to failure(red).
    for (const key of ["queued", "paused", "swept", "blocked"] as StatusKey[]) {
      expect(STATUS_KEY_TONE[key], key).not.toBe("failure");
    }
    // Real-failure keys stay red.
    expect(STATUS_KEY_TONE.failed).toBe("failure");
    expect(STATUS_KEY_TONE.zombie).toBe("failure"); // a LIVE stalled session (ISS-322)
    // ISS-322 — a swept (auto-cleaned) session is neutral, never red.
    expect(STATUS_KEY_TONE.swept).toBe("neutral");
  });
});

describe("HEALTH_META derives from TONE_META", () => {
  it("routes a down runner to the infra tone (distinct from failure)", () => {
    expect(HEALTH_KEY_TONE.down).toBe("infra");
    expect(HEALTH_META.down.dot).toBe(TONE_META.infra.dot);
    // infra and failure must be visually distinct (the offline-vs-failed regression).
    expect(HEALTH_META.down.fg).not.toBe(TONE_META.failure.fg);
  });

  it("maps every health key to its tone's colors", () => {
    for (const key of ["healthy", "attention", "down", "idle"] as const) {
      expect(HEALTH_META[key].dot).toBe(TONE_META[HEALTH_KEY_TONE[key]].dot);
    }
  });
});
