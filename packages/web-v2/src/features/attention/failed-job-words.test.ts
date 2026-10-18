import { describe, expect, it } from "vitest";
import { failedJobWords, failureWords } from "./failed-job-words";

// ISS-1229 r14, judge-35's reader note on 93: a failed job's row read "drive failed: session_lost"
// where the overview says Issue work and Session lost.
describe("a failed job, in words", () => {
  it("names the work and the failure as the overview does, never the stored codes", () => {
    const said = failedJobWords({ jobType: "drive", failure: "session_lost" });
    expect(said).toBe("Issue work failed: Session lost");
    expect(said).not.toMatch(/drive|session_lost/u);
    // One job is one release (ISS-1229 r14, the master on the shots).
    expect(failedJobWords({ jobType: "release_batch", failure: "runner_unreachable" })).toBe(
      "Release failed: Runner unreachable",
    );
  });

  it("says a job that names no failure failed, and nothing more", () => {
    expect(failedJobWords({ jobType: "drive", failure: null })).toBe("Issue work failed");
    expect(failedJobWords({ jobType: "drive", failure: "  " })).toBe("Issue work failed");
  });

  it("reads a code it has no words for as unrecognised, with the code beside it", () => {
    expect(failureWords("quantum_flux")).toBe("Unrecognised failure (quantum_flux)");
    expect(failedJobWords({ jobType: "triage", failure: null })).toBe("Unrecognised work (triage) failed");
  });

  // ISS-1229 r15: judge-38 read the classifier's own sentence where "Session lost" was owed.
  it("says nothing of a failure the job wrote as a sentence: a diagnostic is not words for a person", () => {
    expect(failureWords("agent session terminated without job completion (silent runner/agent death)")).toBeNull();
    expect(failureWords("Agent completed with errors")).toBeNull();
    expect(failedJobWords({ jobType: "drive", failure: "Agent completed with errors" })).toBe("Issue work failed");
  });

  it("refuses a failed job with no kind of work, by name", () => {
    expect(() => failedJobWords({ failure: "session_lost" })).toThrow(/no `jobType`/u);
  });
});
