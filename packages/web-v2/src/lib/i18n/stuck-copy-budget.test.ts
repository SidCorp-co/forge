// The copy ISS-680 adds for the Stuck banner, a re-kinded park and its thread notice keeps the UI
// copy budget (ui-copy-rule 1 and 8, FB-281): a label is 1-3 words, any other string at most 12.
//
// @direct-test-of packages/web-v2/src/lib/i18n/copy/issues.json
// @direct-test-of packages/web-v2/src/lib/i18n/copy/agents.json
// @direct-test-of packages/web-v2/src/lib/i18n/copy/standing.json

import { SAID_ENTRIES } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { PRODUCT_STRINGS } from "./product-copy";

const LABELS = [
  "issues.stuckState.blocked",
  "issues.stuckState.overdue",
  "issues.stuckState.no_owner",
  "issues.stuckState.nobody_serves",
  "issues.stuckState.draft_carrier",
  "issues.stuckState.releaseHeld",
  "issues.stuckState.unknown",
  "issues.thread.waitChanged",
  "issues.waitingKind.unknown",
  "agents.question.resource",
  "agents.question.answerWaiting",
  "standing.who.runnerOwner",
  "standing.who.projectAdmin",
];
const STRINGS = ["issues.thread.nowWaitsOn"];
/** Core's acts a person must take on a release hold. */
const HOLD_ACTS = Object.keys(SAID_ENTRIES).filter((k) => k.startsWith("issues.releaseHold.act."));

/** Words as a reader counts them: a `{slot}` is one, a separator mark is none. */
const words = (text: string) => text.split(/\s+/).filter((w) => w && !/^[·:—-]$/.test(w)).length;

const textOf = (key: string): string | undefined => PRODUCT_STRINGS.en[key] ?? (SAID_ENTRIES as Record<string, { en: string }>)[key]?.en;

describe("the copy ISS-680 adds keeps the budget", () => {
  it("every label is 1-3 words", () => {
    const over = LABELS.filter((k) => {
      const n = words(textOf(k) ?? "");
      return n < 1 || n > 3;
    });
    expect(over).toEqual([]);
  });

  it("every other string is at most 12 words, and none is missing", () => {
    const keys = [...STRINGS, ...HOLD_ACTS];
    expect(HOLD_ACTS.length).toBeGreaterThan(30);
    const missing = keys.filter((k) => !textOf(k));
    const over = keys.filter((k) => words(textOf(k) ?? "") > 12);
    expect({ missing, over }).toEqual({ missing: [], over: [] });
  });
});
