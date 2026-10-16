import { REGISTRY_JOB_TYPES } from "@forge/contracts/pipeline-registry";
import { describe, expect, it } from "vitest";
import { JOB_KIND_LABEL, jobKindLabel } from "./job-kinds";

// ISS-1228 round 9: every kind of work reads in words. A stored step name the registry no longer
// names — a retired kind still inside the dashboard's window — reads as its words, never as code.
describe("jobKindLabel", () => {
  it("names every kind the pipeline can record in the Overview's words", () => {
    for (const type of REGISTRY_JOB_TYPES) expect(jobKindLabel(type)).toBe(JOB_KIND_LABEL[type]);
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
