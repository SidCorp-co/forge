import { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";
import { describe, expect, it } from "vitest";
import { jobKindLabel } from "./job-kinds";

// ISS-1228 round 9: every kind of work reads in words. A stored step name the registry no longer
// names — a retired kind still inside the dashboard's window — reads as its words, never as code.
describe("jobKindLabel", () => {
  it.each([
    ["drive", "Issue work"],
    ["release_batch", "Releases"],
    ["reconcile", "Skill updates"],
    ["verify_skill", "Skill checks"],
    ["smoke", "Skill trial runs"],
    ["pm", "Project manager"],
    ["custom", "Custom prompts"],
  ])("names the kind %j %j", (type, words) => {
    expect(jobKindLabel(type)).toBe(words);
  });

  it("names every kind the pipeline can record, none of them by its stored name", () => {
    for (const type of REGISTRY_JOB_TYPES) expect(jobKindLabel(type)).not.toMatch(/_|^[a-z]/);
  });

  it.each([
    ["triage", "Triage"],
    ["review_followup_rework_after_codex_consult", "Review followup rework after codex consult"],
    ["verify-skill", "Verify skill"],
  ])("reads the retired kind %j as %j", (stored, words) => {
    expect(jobKindLabel(stored)).toBe(words);
  });

  it("never shows a stored name, an underscore or the word Unrecognised", () => {
    for (const stored of ["triage", "review_followup_rework_after_codex_consult", "x__y"]) {
      const label = jobKindLabel(stored);
      expect(label).not.toMatch(/_|Unrecognised|\(/);
      expect(label).not.toBe(stored);
    }
  });
});
