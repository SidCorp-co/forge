/**
 * ISS-1176 — the two pages written for a person who has never used Forge speak the screen's
 * language. A file path, a tool name or a status in its stored form sends that reader to a word the
 * screen never shows them, and a promise of how long something takes is one the product does not
 * make.
 */

import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";

const PERSON_PAGES = ["file-a-request", "what-done-means"] as const;

const STORED_STATUSES = [
  "open", "confirmed", "clarified", "waiting", "approved", "in_progress", "developed", "testing",
  "tested", "awaiting_release", "releasing", "closed", "reopen", "on_hold", "needs_info", "draft",
  "dropped",
];

const RULES: Array<{ rule: string; offends: RegExp }> = [
  { rule: "a file path", offends: /(?:^|[\s(`])(?:packages|src|docs|content)\/|\.(?:ts|tsx|mjs|json)\b/ },
  { rule: "a tool name", offends: /\bforge_[a-z_]+\b|\bMCP\b|\bforge-runner\b|\bforge [a-z]+ -/ },
  {
    rule: "a status in its stored form",
    offends: new RegExp(`\`(?:${STORED_STATUSES.join("|")})\`|\\b(?:in_progress|awaiting_release|on_hold|needs_info)\\b`),
  },
  {
    rule: "a promise of how long anything takes",
    offends:
      /\bwithin\s+(?:a|an|\d+)\s+(?:minute|hour|day|week)|\b\d+\s*(?:–|-|to)\s*\d+\s+(?:minutes|hours|days|business days)\b|\bshortly\b|\bin (?:a few|\d+) (?:minutes|hours|days)\b|\bafter a short (?:while|period)\b/i,
  },
];

function offences(body: string): string[] {
  return RULES.filter(({ offends }) => offends.test(body)).map(({ rule }) => rule);
}

describe("the pages written for a person, in the screen's own words", () => {
  it.each(PERSON_PAGES)("%s is published", (slug) => {
    expect(HELP_DOCS.map((d) => d.slug)).toContain(slug);
  });

  it.each(PERSON_PAGES)("%s names no path, tool, stored status or timing promise", (slug) => {
    const body = HELP_DOCS.find((d) => d.slug === slug)?.body ?? "";
    expect(offences(body)).toEqual([]);
  });
});

describe("that guard, against one planted sentence per rule", () => {
  it.each([
    ["The form lives in packages/web-v2/src/features/issues.", "a file path"],
    ["An agent files it with forge_issues for you.", "a tool name"],
    ["The status becomes `closed` once it ships.", "a status in its stored form"],
    ["It moves to needs_info when a question is asked.", "a status in its stored form"],
    ["Most requests are completed within 2 days.", "a promise of how long anything takes"],
    ["Most requests are completed in 1–3 business days.", "a promise of how long anything takes"],
  ])("rejects %s", (sentence, rule) => {
    expect(offences(sentence)).toEqual([rule]);
  });

  it("lets the screen's own words through", () => {
    const shipped = [
      "Choose **Create issue**. You land on the new issue's page.",
      "The status becomes **Needs info** and its question appears on the issue page.",
      "At **Awaiting release** it has not been released yet — the issue page says when it will be.",
    ].join(" ");
    expect(offences(shipped)).toEqual([]);
  });
});
