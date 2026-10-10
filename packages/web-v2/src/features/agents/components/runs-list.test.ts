// FB-122: ISSUE_SCOPE_HELD names the holding run by the id its box declared it under, so the Runs
// list's search finds a run by that id as well as by core's.

import type { RunStanding } from "@forge/contracts/run-standing";
import { describe, expect, it } from "vitest";
import { runSearchText } from "./runs-list";

const run = (over: Partial<RunStanding>) => ({ id: "0f6c1e2a-0000-4000-8000-000000000001", boxRunId: null, title: "Build", issue: null, device: null, release: null, issues: [], ...over }) as RunStanding;

describe("the Runs search", () => {
  it("finds a run by the box run id a refusal names", () => {
    expect(runSearchText(run({ boxRunId: "iss-12-r2-a7f3" }))).toContain("iss-12-r2-a7f3");
  });

  it("finds a run by core's id too", () => {
    expect(runSearchText(run({}))).toContain("0f6c1e2a");
  });

  it("finds nothing for an id no run carries", () => {
    expect(runSearchText(run({ boxRunId: "iss-12-r2-a7f3" }))).not.toContain("iss-99-r1");
  });
});
