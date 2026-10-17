import { describe, expect, it } from "vitest";
import { leaseDisagreementText } from "./lease-words";

describe("the lease disagreement, in one sentence (ISS-1228 round 12)", () => {
  it("names the issue, core's hold and what frees it", () => {
    expect(leaseDisagreementText(["ISS-3"])).toBe(
      "The box says it returned ISS-3. Core still holds it. Stop the session to free it.",
    );
  });

  it("names every issue at once, in the plural", () => {
    expect(leaseDisagreementText(["ISS-3", "ISS-4"])).toBe(
      "The box says it returned ISS-3, ISS-4. Core still holds them. Stop the session to free them.",
    );
  });

  it("says nothing where the box and core agree", () => {
    expect(leaseDisagreementText([])).toBeNull();
  });
});
