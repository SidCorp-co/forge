import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { formatApiError } from "./error";

describe("formatApiError on a refused session", () => {
  it("never shows core's own words for a 401 under an unmapped code", () => {
    const line = formatApiError(new ApiError(401, "invalid token", "SOMETHING_NEW"));
    expect(line).toBe("Your session has expired. Please sign in again.");
  });
  it("keeps the sentence of a 401 that has its own (wrong password)", () => {
    expect(formatApiError(new ApiError(401, "x", "INVALID_CREDENTIALS"))).toBe("Email or password is incorrect.");
  });
  it("still shows a non-401 refusal's sentence", () => {
    expect(formatApiError(new ApiError(422, "title is too long", "UNMAPPED"))).toBe("title is too long");
  });
});
