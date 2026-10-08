import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import { WORK_STATES } from "@forge/contracts/work-state";
import { filterCount } from "./derive";
import { issueKeyRefusalOf, NO_ISSUE_BUCKETS } from "./key-refusal";

describe("issueKeyRefusalOf (ISS-1334)", () => {
  it.each(["ISSUE_KEY_NOT_HELD", "ISSUE_KEY_FOREIGN_PREFIX", "ISSUE_KEY_OUT_OF_RANGE"])(
    "answers the server's sentence for %s",
    (code) => {
      const said = "`ISS-9999` reads as an issue key, and this project holds no issue ISS-9999.";
      expect(issueKeyRefusalOf(new ApiError(404, said, code))).toBe(said);
    },
  );

  it("leaves every other failure to the retryable error state", () => {
    expect(issueKeyRefusalOf(new ApiError(500, "boom", "INTERNAL"))).toBeNull();
    expect(issueKeyRefusalOf(new ApiError(400, "Invalid input", "BAD_REQUEST"))).toBeNull();
    expect(issueKeyRefusalOf(new ApiError(404, "gone"))).toBeNull();
    expect(issueKeyRefusalOf(new Error("network"))).toBeNull();
    expect(issueKeyRefusalOf(null)).toBeNull();
  });
});

describe("NO_ISSUE_BUCKETS (ISS-1334)", () => {
  it("counts 0 under every tab and outcome, so a refused key keeps every count drawn", () => {
    for (const f of ["all", ...WORK_STATES] as const) {
      expect(filterCount(f, NO_ISSUE_BUCKETS), f).toBe(0);
    }
    for (const s of REGISTRY_ISSUE_STATUSES) expect(NO_ISSUE_BUCKETS.byStatus[s], s).toBe(0);
  });
});
