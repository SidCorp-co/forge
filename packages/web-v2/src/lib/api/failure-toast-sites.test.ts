// ISS-1229 r25: every toast for a failed request is built by `failureToast`, so a refusal is titled by
// what did not happen, never "Update failed" or "Action failed".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

/** Every non-test source file under the web app's `src`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Each `toast(...)` call in a file, whole, found by balancing its parentheses. */
function toastCalls(text: string): string[] {
  const calls: string[] = [];
  for (let at = text.indexOf("toast("); at >= 0; at = text.indexOf("toast(", at + 1)) {
    let depth = 0;
    for (let i = at + "toast".length; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        calls.push(text.slice(at, i + 1));
        break;
      }
    }
  }
  return calls;
}

/** A failed request's words, which only `failureToast` may put under a title. */
const REQUEST_FAILURE = /formatApiError\(|formatPipelineConfigError\(|formatSettingsWriteError\(/;

/** The toasts that show a failed request without going through `failureToast`, by file. */
function unroutedFailureToasts(files: ReadonlyArray<{ file: string; text: string }>): string[] {
  return files.flatMap(({ file, text }) =>
    toastCalls(text)
      .filter((call) => /tone:\s*["']error["']/.test(call) && REQUEST_FAILURE.test(call) && !call.includes("failureToast("))
      .map((call) => `${file}: ${call.replace(/\s+/g, " ").slice(0, 120)}`),
  );
}

const app = () => sources(root).map((file) => ({ file: relative(root, file), text: readFileSync(file, "utf8") }));

describe("every toast for a failed request", () => {
  it("is built by failureToast, so a refusal is titled by what did not happen", () => {
    expect(unroutedFailureToasts(app())).toEqual([]);
  });

  it('is never titled "Update failed" or "Action failed"', () => {
    const titled = app()
      .filter(({ text }) => /title:\s*["'`](Update|Action) failed/.test(text))
      .map(({ file }) => file);
    expect(titled).toEqual([]);
  });

  // The rule is planted: a refusal titled as round 24 found most of the app titling one goes red.
  it("finds a failed request's toast built by hand", () => {
    const planted = `onError: (err) => {
      toast({ title: "Update failed", description: formatApiError(err), tone: "error" });
    },`;
    expect(unroutedFailureToasts([{ file: "planted.ts", text: planted }])).toHaveLength(1);
    expect(unroutedFailureToasts([{ file: "routed.ts", text: "toast(failureToast(err, \"The issue was not updated\"))" }])).toEqual([]);
  });
});
