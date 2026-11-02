// @vitest-environment node
// Every screen a witness fixture draws stays within its word budget on its first view at 1440x900
// (REQ-11 BC-21, ISS-903). jsdom lays nothing out, so it cannot tell a word on the first view from
// one below the fold: the screens are drawn in headless Chrome by the screen witness
// (witness/screens-all.witness.tsx), and each one's words are counted there by witness/first-screen.ts,
// the rule the audit measured with. The test fails naming the screen, its count and its budget.
//
// It costs one witness run, about a minute. Chrome (`WITNESS_CHROME`, else `google-chrome`) is a
// program the whole-tree guard cannot read inside, so it counts the run as listing the root, and the
// test runs on every change; it reads only the web package and its own fresh profile. A box without
// Chrome fails here by name rather than skipping.
// @gate-input whole-tree

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUDGETS, countsOf, MOST_WORDS, overBudget } from "../../witness/screens.budgets";

const WEB = resolve(import.meta.dirname, "../..");
const out = mkdtempSync(join(tmpdir(), "screen-budget-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the word budget's judgement", () => {
  it("names a screen over its budget, with its count and its budget", () => {
    expect(overBudget(new Map([["docs", 101]]), { docs: { budget: 100 } })).toEqual(["docs: 101 words on its first view, over its budget of 100"]);
    expect(overBudget(new Map([["docs", 100]]), { docs: { budget: 100 } })).toEqual([]);
  });

  it("holds an amnestied screen at its measured ceiling, and refuses the amnesty once the screen is within budget", () => {
    const amnestied = { status: { budget: 100, amnesty: { ceiling: 145, ends: "slice B" } } };
    expect(overBudget(new Map([["status", 145]]), amnestied)).toEqual([]);
    expect(overBudget(new Map([["status", 146]]), amnestied)).toEqual(["status: 146 words on its first view, over its amnesty's ceiling of 145 (budget 100; slice B)"]);
    expect(overBudget(new Map([["status", 99]]), amnestied)).toEqual(["status: 99 words is within its budget of 100, so its amnesty (slice B) is spent: remove it"]);
  });

  it("refuses a budget over 110, a budget for a screen not drawn, and a drawn screen with no budget", () => {
    expect(overBudget(new Map([["a", 5]]), { a: { budget: 111 } })).toEqual([`a: a budget of 111 words is over the ${MOST_WORDS} any first view may hold`]);
    expect(overBudget(new Map(), { gone: { budget: 10 } })).toEqual(["gone: has a budget but the witness drew no such screen"]);
    expect(overBudget(new Map([["new-screen", 3]]), {})).toEqual(["new-screen: drawn with no word budget: give it the audit's target"]);
  });

  it("reads the witness's lines, one count per screen", () => {
    const said = "witness: page says WORDS docs light 98 :: Docs Search\nwitness: page says WORDS ops light 38 :: Ops";
    expect([...countsOf(said)]).toEqual([["docs", 98], ["ops", 38]]);
  });

  it("gives no screen a budget over 110", () => {
    expect(Object.entries(BUDGETS).filter(([, b]) => b.budget > MOST_WORDS)).toEqual([]);
  });
});

describe("every witnessed screen's first view", () => {
  it("is within its word budget at 1440x900", () => {
    const run = spawnSync(process.execPath, ["witness/run.mjs", "witness/screens-all.witness.tsx", "--out", out], {
      cwd: WEB,
      encoding: "utf8",
      // vitest's NODE_ENV=test would build the page on React's dev runtime, which the bundle does not carry
      env: { ...process.env, NODE_ENV: "production", VITE_WITNESS_THEMES: "light", VITE_WITNESS_ONLY: "" },
      timeout: 540_000,
    });
    const said = `${run.stdout}\n${run.stderr}`;
    const counts = countsOf(said);
    expect(counts.size, `the screen witness drew nothing (exit ${run.status}):\n${said.slice(-2000)}`).toBeGreaterThan(0);
    expect(run.status, `the screen witness failed (exit ${run.status}):\n${said.slice(-2000)}`).toBe(0);
    expect(overBudget(counts)).toEqual([]);
  }, 600_000);
});
