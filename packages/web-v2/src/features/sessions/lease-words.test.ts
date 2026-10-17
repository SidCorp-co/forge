import { describe, expect, it } from "vitest";
import { leaseDisagreementText } from "./lease-words";

describe("the lease disagreement, in one sentence (ISS-1228 round 12)", () => {
  it("names the issue, core's hold and what frees it", () => {
    expect(leaseDisagreementText(["ISS-3"])).toBe(
      "the box says it returned ISS-3 · core still holds it · stop the session to free it",
    );
  });

  it("names every issue at once, in the plural", () => {
    expect(leaseDisagreementText(["ISS-3", "ISS-4"])).toBe(
      "the box says it returned ISS-3, ISS-4 · core still holds them · stop the session to free them",
    );
  });

  it("says nothing where the box and core agree", () => {
    expect(leaseDisagreementText([])).toBeNull();
  });
});
