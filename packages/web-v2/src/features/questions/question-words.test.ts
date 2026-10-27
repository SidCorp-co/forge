// ISS-1421 r38, judge-155: the Decision waiting card showed the stored values "human" and "open" as tags.

import { describe, expect, it } from "vitest";
import { ANSWERED_STATE, questionStateLine, WAITS_ON } from "./question-words";
import type { BlockerKind, QuestionStatus } from "./types";

const KINDS: BlockerKind[] = ["human", "master_or_peer", "machine"];
const STATUSES: QuestionStatus[] = ["open", "answered", "void", "expired", "needs_info"];
const STORED = /\b(?:human|master_or_peer|machine|open|void|needs_info)\b|_/;

describe("a question's state, as its card says it", () => {
  it("says the person-held, unanswered question in words", () => {
    expect(questionStateLine("human", "open")).toBe("Waits on a person · not answered yet");
  });

  it.each(KINDS.flatMap((k) => STATUSES.map((s) => [k, s] as const)))(
    "says %s and %s with no stored value",
    (kind, status) => {
      expect(questionStateLine(kind, status)).not.toMatch(STORED);
    },
  );

  it("tells every kind and every status apart", () => {
    expect(new Set(Object.values(WAITS_ON)).size).toBe(KINDS.length);
    expect(new Set(Object.values(ANSWERED_STATE)).size).toBe(STATUSES.length);
  });
});
