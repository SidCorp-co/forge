// ISS-1229 r24, the master's ruling on judge-70's finding: the organization delete, refused with a
// sentence, was titled "Request failed", which reads as a fault. A refusal is titled by what did not
// happen; "Request failed" is kept for a fault.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { FAULT_TITLE, failureToast } from "./failure-toast";

describe("a failed request's toast", () => {
  it.each([403, 404, 409, 422])("is titled by what did not happen for a %i refusal", (status) => {
    const toast = failureToast(new ApiError(status, "This organization still holds 2 projects."), "The organization was not deleted");
    expect(toast.title).toBe("The organization was not deleted");
    expect(toast.description).toBe("This organization still holds 2 projects.");
    expect(toast.tone).toBe("error");
  });

  it.each([
    ["a server fault", new ApiError(500, "")],
    ["an unreachable server", new TypeError("Failed to fetch")],
  ])("keeps %s titled as a fault", (_what, err) => {
    expect(failureToast(err, "The organization was not deleted").title).toBe(FAULT_TITLE);
    expect(FAULT_TITLE).toBe("Request failed");
  });
});

/** Every non-test source file under the web app's `src`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the web app's toasts", () => {
  it('title no failure "Request failed" except through failureToast, which keeps it for a fault', () => {
    const root = join(import.meta.dirname, "..", "..");
    const titled = sources(root).filter(
      (file) => !file.endsWith(join("lib", "api", "failure-toast.ts")) && /title:\s*["'`]Request failed/.test(readFileSync(file, "utf8")),
    );
    expect(titled.map((f) => relative(root, f))).toEqual([]);
  });
});
