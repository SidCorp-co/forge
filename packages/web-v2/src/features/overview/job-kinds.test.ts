import { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";
import { describe, expect, it } from "vitest";
import { jobKindLabel, jobKindsLabel } from "./job-kinds";

// ISS-1228 round 9: every kind of work reads in words. A stored step name the registry no longer
// names — a retired kind still inside the dashboard's window — reads as its words, never as code.
// ISS-1229 r14: one job is named in the singular ("Release failed"), a group of them in the plural.
describe("jobKindLabel", () => {
  it.each([
    ["drive", "Issue work", "Issue work"],
    ["release_batch", "Release", "Releases"],
    ["reconcile", "Skill update", "Skill updates"],
    ["verify_skill", "Skill check", "Skill checks"],
    ["smoke", "Skill trial run", "Skill trial runs"],
    ["pm", "Project manager", "Project manager"],
    ["custom", "Custom prompt", "Custom prompts"],
  ])("names one job of the kind %j %j, and several %j", (type, one, many) => {
    expect(jobKindLabel(type)).toBe(one);
    expect(jobKindsLabel(type)).toBe(many);
  });

  it("names every kind the pipeline can record, none of them by its stored name", () => {
    for (const type of REGISTRY_JOB_TYPES) expect(jobKindLabel(type)).not.toMatch(/_|^[a-z]/);
  });

  // ISS-1229 r13: a kind with no words reads as unknown with its type; made-up words would pass as known.
  // The ruling is the forge-dev master's, on criterion 23.
  it.each([
    ["triage", "Unrecognised work (triage)"],
    ["triage_legacy_x", "Unrecognised work (triage_legacy_x)"],
    ["verify-skill", "Unrecognised work (verify-skill)"],
  ])("reads the kind %j it has no words for as %j", (stored, label) => {
    expect(jobKindLabel(stored)).toBe(label);
  });

  it("reads a kind with no name at all as unrecognised, with nothing in brackets", () => {
    expect(jobKindLabel("  ")).toBe("Unrecognised work");
  });
});
