// @vitest-environment jsdom
/**
 * ISS-1176, ISS-1178 — every page written for a person using Forge speaks the screen's language.
 * A file path, a table or column name, a tool name or a status in its stored form sends that reader
 * to a word the screen never shows them, and a promise of how long something takes is one the
 * product does not make. The rule is the `user` audience's, stated with the other two in
 * docs/modules/guides/where-a-page-lives.md.
 */

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { QualitySection } from "@/features/overview/components/quality-section";
import { JOB_KIND_LABEL } from "@/features/overview/job-kinds";
import type { PulseQuality } from "@/features/overview/types";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { GAP_TEXT } from "@/features/project-settings/components/release-section";
import { HELP_DOCS } from "./help-content.generated";

afterEach(cleanup);

const PERSON_PAGES = ["file-a-request", "what-done-means"] as const;
const USER_PAGES = HELP_DOCS.filter((d) => d.audience === "user").map((d) => d.slug);

const STORED_STATUSES = [
  "open", "confirmed", "clarified", "waiting", "approved", "in_progress", "developed", "testing",
  "tested", "awaiting_release", "releasing", "closed", "reopen", "on_hold", "needs_info", "draft",
  "dropped",
];

const RULES: Array<{ rule: string; offends: RegExp }> = [
  { rule: "a file path", offends: /(?:^|[\s(`])(?:packages|src|docs|content)\/|\.(?:ts|tsx|mjs|json)\b/ },
  { rule: "a table or column name", offends: /\b[a-z]+(?:_[a-z0-9]+)+\b/ },
  // `forge-runner` is not here: it is the program a runner's owner installs and types, which is
  // on that reader's screen.
  { rule: "a tool name", offends: /\bforge_[a-z_]+\b|\bMCP\b|\bforge [a-z]+ -/ },
  {
    rule: "a status in its stored form",
    offends: new RegExp(`\`(?:${STORED_STATUSES.join("|")})\`|\\b(?:in_progress|awaiting_release|on_hold|needs_info)\\b`),
  },
  {
    rule: "a promise of how long anything takes",
    offends:
      /\bwithin\s+(?:a|an|\d+)\s+(?:minute|hour|day|week)|\b\d+\s*(?:–|-|to)\s*\d+\s+(?:minutes|hours|days|business days)\b|\bshortly\b|\bin (?:a few|\d+) (?:minutes|hours|days)\b|\bafter a short (?:while|period)\b/i,
  },
  // ISS-1229: one job drives an issue end to end, so Settings has no per-stage control to set.
  {
    rule: "a per-stage setting Settings does not have",
    offends:
      /\*\*(?:Auto|Manual|Skip)\*\*|\bstages?\b[^.]*\b(?:turned off|skipped|waits? for your click|per your settings)/i,
  },
  // ISS-1229: the staged pipeline is retired, so no page walks an issue through its stages.
  {
    rule: "a walk through the retired stages",
    offends:
      /\b(?:triage|clarify|plan|code|review|test|staging|release|fix)[*_`]*\s*(?:→|->|&rarr;)\s*[*_`]*(?:triage|clarify|plan|code|review|test|staging|release|fix)\b/i,
  },
  {
    rule: "a retired stage as a step an issue moves through",
    offends:
      /\b(?:triage|clarify|plan|code|review|test|staging|release|fix)[*_`]*\s+(?:step|stage)s?\b|\bmov(?:e|es|ed|ing)\b[^.]*\bthrough\b[^.]*\b(?:triage|clarify|plan|code|review|test|staging|fix)\b/i,
  },
  // ISS-1229 r5: a notice printed Postgres's own text for a time. The reader is in a timezone the
  // server does not know, so a time is said as how long ago, never as the stored value.
  {
    rule: "a database timestamp",
    offends:
      /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\.\d+(?:Z|[+-]\d{2})/,
  },
  // ISS-1229 r5: the Overview headed its work table "Stage" and called it "Jobs by pipeline stage".
  {
    rule: "a pipeline stage the pipeline does not have",
    offends: /\bpipeline stages?\b|\b(?:by|per|each) stage\b|^\s*Stage\s*$/im,
  },
  // ISS-1229 r5: Shape & release said "No build-commands fact": the key a knowledge entry is
  // stored under, and the word an agent uses for it.
  {
    rule: "a stored knowledge key, or the agent's word fact",
    offends: /\b(?:build|test)-commands\b|\brelease-procedure\b|\b[a-z]+(?:-[a-z]+)+ facts?\b/i,
  },
  // ISS-1229 r5: Shape & release drew `testing` and `awaiting_release` as code beside a link
  // reading "Awaiting release". Code marks a value to type; a status is read, by its label.
  {
    rule: "a status written as code",
    offends: new RegExp(`<code[^>]*>\\s*(?:${STORED_STATUSES.join("|")})\\s*</code>`),
  },
  // A draft with nothing merged cannot be closed, so the way to turn one down is to drop it.
  {
    rule: "a draft turned down by closing it",
    offends: /\b(?:reject|decline|turn(?:s|ing)?\s+(?:\S+\s+)?down)\b[^.]*\bclos(?:e|es|ed|ing)\b/i,
  },
];

function offences(body: string): string[] {
  return RULES.filter(({ offends }) => offends.test(body)).map(({ rule }) => rule);
}

describe("the pages written for a person, in the screen's own words", () => {
  it.each(PERSON_PAGES)("%s is published for a person using Forge", (slug) => {
    expect(USER_PAGES).toContain(slug);
  });

  it("covers every page that declares audience user", () => {
    expect(USER_PAGES.length).toBeGreaterThan(PERSON_PAGES.length);
  });

  it.each(USER_PAGES)("%s names no path, table, tool, stored status, timing promise, stage setting, retired stage or closed draft", (slug) => {
    const body = HELP_DOCS.find((d) => d.slug === slug)?.body ?? "";
    expect(offences(body)).toEqual([]);
  });
});

describe("that guard, against one planted sentence per rule", () => {
  it.each([
    ["The form lives in packages/web-v2/src/features/issues.", "a file path"],
    ["An agent files it with forge_issues for you.", "a tool name"],
    ["Consult `integration_guides`.", "a table or column name"],
    ["Closing it stamps merged_at.", "a table or column name"],
    ["Ask your assistant over MCP.", "a tool name"],
    ["Run forge issue -h to list them.", "a tool name"],
    ["The status becomes `closed` once it ships.", "a status in its stored form"],
    ["It moves to needs_info when a question is asked.", "a status in its stored form"],
    ["Most requests are completed within 2 days.", "a promise of how long anything takes"],
    ["Most requests are completed in 1–3 business days.", "a promise of how long anything takes"],
    ["Set the **Code** stage to **Manual**.", "a per-stage setting Settings does not have"],
    ["A stage can be turned off for the project.", "a per-stage setting Settings does not have"],
    ["Each stage runs an agent or\n  waits for your click, per your settings.", "a per-stage setting Settings does not have"],
    ["Agents move it through triage → plan → code → review → release.", "a walk through the retired stages"],
    ["It runs triage -> clarify -> plan.", "a walk through the retired stages"],
    ["A failed review goes review → fix.", "a walk through the retired stages"],
    ["It loops fix -> code.", "a walk through the retired stages"],
    ["The code step opens a pull request.", "a retired stage as a step an issue moves through"],
    ["A failed check sends it back to the review stage.", "a retired stage as a step an issue moves through"],
    ["Agents move it through triage, then review.", "a retired stage as a step an issue moves through"],
    ["The **Code** stage opens a pull request.", "a retired stage as a step an issue moves through"],
    ["It returns to the `review` step.", "a retired stage as a step an issue moves through"],
    ["It runs **Triage** → **Plan**.", "a walk through the retired stages"],
    ["Approve one by moving it to **Open**;\nturn it down by closing it.", "a draft turned down by closing it"],
    ["Reject a gated draft by closing it.", "a draft turned down by closing it"],
    ["ISS-78 (in progress) has asserted work since 2026-10-15 10:26:16.817935+00.", "a database timestamp"],
    ["It was last seen at 10:26:16.817935+00.", "a database timestamp"],
    ["Updated 2026-10-15T10:26:16Z.", "a database timestamp"],
    ["Jobs by pipeline stage over 90 days.", "a pipeline stage the pipeline does not have"],
    ["Stage", "a pipeline stage the pipeline does not have"],
    ["Median time per stage.", "a pipeline stage the pipeline does not have"],
    ["No build-commands fact — a session has nothing to build with.", "a stored knowledge key, or the agent's word fact"],
    ["Write the release-procedure in Knowledge.", "a stored knowledge key, or the agent's word fact"],
    ["Runner unreachable: runner_unreachable", "a table or column name"],
    ["no issue is at <code>testing</code> or at <code>tested</code>.", "a status written as code"],
    ['It reaches the gate at <code class="fg-code">awaiting_release</code>.', "a status written as code"],
  ])("rejects %s", (sentence, rule) => {
    expect(offences(sentence)).toContain(rule);
  });

  it("lets the screen's own words through", () => {
    const shipped = [
      "No build commands written — an agent has nothing to build with.",
      "It has been parked for 3 days.",
      "Runner unreachable",
      "Nothing is ready to release: no issue is at Testing, Tested or Awaiting release.",
      "A <code>cut-below</code> releases only what landed before it.",
      "Choose **Create issue**. You land on the new issue's page.",
      "The status becomes **Needs info** and its question appears on the issue page.",
      "At **Awaiting release** it has not been released yet — the issue page says when it will be.",
      "Install forge-runner on the machine, then run `forge-runner pair` with the code.",
    ].join(" ");
    expect(offences(shipped)).toEqual([]);
  });
});

describe("the done page, where it says what Closed means", () => {
  const done = () => HELP_DOCS.find((d) => d.slug === "what-done-means")?.body ?? "";

  it("says an issue closed before the shipped rule may carry no record of shipping", () => {
    expect(done()).toMatch(/closed before that rule existed may have no \*\*Merged\*\* row/);
  });

  it("does not say a dropped issue had nothing built", () => {
    expect(done()).not.toMatch(/\*\*Dropped\*\*[^\n]*nothing was built/i);
  });
});

// ISS-1229 round 5 — judge-15 read these screens and found the words the rules above refuse. Each
// is held to the same rules as a help page, so the old wording goes red here as well as beside it.
describe("the screens judge-15 read, against the same rules", () => {
  it("Shape & release names every unwritten instruction in the screen's words", () => {
    for (const text of Object.values(GAP_TEXT)) expect([text, offences(text)]).toEqual([text, []]);
  });

  // The blocker sentence is core's (release-batch/blocker-sentences.ts); this is the screen's half:
  // what Shape & release draws from it. The core test holds every sentence to the same rule.
  it.each([
    ["now", "Nothing is ready to release: 2 issues are at Testing or Tested, and each moves to Awaiting release once it records where its change now runs.", []],
    [
      "before ISS-1229 r5",
      "Nothing is waiting at the release gate, and nothing stands one move short of it: no issue on this project is at `testing` or at `tested`. An issue reaches the gate at `awaiting_release`.",
      ["a status written as code"],
    ],
  ])("Shape & release draws the release blocker as written %s", (_when, sentence, found) => {
    const { container } = render(createElement("p", null, inlineCode(sentence)));
    expect(offences(container.innerHTML).filter((r) => r === "a status written as code")).toEqual(found);
  });

  // ISS-1229 r5d: core's refusals reach a screen through the same inlineCode; reader-status-words
  // in core scans their source.
  it.each([
    [
      "the criteria hold, now",
      "Every issue at Awaiting release still owes a verdict on an acceptance criterion, so the automatic release cuts nothing until each is recorded: `ISS-754` owes criteria 1–30.",
      [],
    ],
    [
      "the criteria hold, before ISS-1229 r5",
      "This project releases without a person acting, and the sweep that cuts its releases is holding back every issue waiting at the gate: each still owes a judging run on an acceptance criterion. Record a verdict for each criterion named below, or move the issue out of `awaiting_release` if it is not to ship.",
      ["a status written as code"],
    ],
    [
      "a close refused for want of a tag, now",
      "this project ships by version tag, so Closed means a tag matching `v*` contains the landing commit 1a2b3c4d5e6f, and no tag contains it yet. The issue rests at Awaiting release until a tag that contains it is cut and deployed.",
      [],
    ],
    [
      "a close refused for want of a tag, before ISS-1229 r5d",
      "this project ships by version tag, so `closed` means a tag matching `v*` contains the landing commit 1a2b3c4d5e6f, and no tag contains it yet. The issue rests at `awaiting_release` until a tag that contains it is cut and deployed.",
      ["a status written as code"],
    ],
    [
      "a refused unmark, before ISS-1229 r5d",
      "Move it off `closed` first — `reopen` is the only exit `closed` has — and then `unmark`, or take `dropped` from `reopen`.",
      ["a status written as code"],
    ],
    [
      "a refused unmark, now",
      "Move it off Closed first — Reopened is the only exit Closed has — and then `unmark`, or take Dropped from Reopened.",
      [],
    ],
  ])("a refusal core sends, drawn as %s", (_when, sentence, found) => {
    const { container } = render(createElement("p", null, inlineCode(sentence)));
    expect(offences(container.innerHTML).filter((r) => r === "a status written as code")).toEqual(found);
  });

  it("every kind of work the Overview counts is named in the screen's words", () => {
    for (const label of Object.values(JOB_KIND_LABEL)) expect([label, offences(label)]).toEqual([label, []]);
  });

  it("the Overview's quality section, drawn, prints no stage, stored code or stored type", () => {
    const quality = {
      finished: { merged: 1, closedUnmerged: 0, dropped: 0 },
      reopened: { issues: 0, events: 0 },
      runFailure: {
        pipeline: { failed: 1, total: 2 },
        scheduler: { failed: 0, total: 0 },
        other: { failed: 0, total: 0 },
      },
      sessionFailures: [
        { reason: "runner_unreachable", count: 3 },
        { reason: "no_client_ack", count: 1 },
      ],
      pipelineFlow: [
        { type: "drive", count: 4, medianSeconds: 600 },
        { type: "release_batch", count: 1, medianSeconds: 300 },
        { type: "verify_skill", count: 2, medianSeconds: 60 },
      ],
    } as unknown as PulseQuality;
    const { container } = render(createElement(QualitySection, { quality }));
    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent ?? "");
    for (const text of [container.textContent ?? "", ...headers]) {
      expect([text, offences(text)]).toEqual([text, []]);
    }
  });
});
