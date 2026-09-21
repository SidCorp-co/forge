// ISS-1083 — the summary rule, on its axes. The card's own test mounts it; this one pins the rule
// itself, including the one property the rule exists for: that no tool's name and no field's name
// can change the answer.

import { describe, expect, it } from "vitest";
import { decodeToolOutput, formatResultBody, summarizeResult } from "./result-summary";

describe("what the summary says", () => {
  it("counts an object's fields", () => {
    expect(summarizeResult({ a: 1, b: 2, c: 3, d: 4 }).label).toBe("Object · 4 fields");
    expect(summarizeResult({ a: 1 }).label).toBe("Object · 1 field");
    expect(summarizeResult({}).label).toBe("Object · 0 fields");
  });

  it("counts an array's items", () => {
    expect(summarizeResult([1, 2, 3]).label).toBe("Array · 3 items");
    expect(summarizeResult(["only"]).label).toBe("Array · 1 item");
    expect(summarizeResult([]).label).toBe("Array · 0 items");
  });

  it("measures a string", () => {
    expect(summarizeResult("a".repeat(86)).label).toBe("Text · 86 characters");
    expect(summarizeResult("x").label).toBe("Text · 1 character");
  });

  it("lets a number or a boolean be its own answer", () => {
    expect(summarizeResult(0).label).toBe("0");
    expect(summarizeResult(42).label).toBe("42");
    expect(summarizeResult(false).label).toBe("false");
  });

  it("tells a call still out from one that returned nothing", () => {
    expect(summarizeResult(undefined, false, true)).toEqual({
      label: "Running…",
      hasBody: false,
      pending: true,
    });
    expect(summarizeResult(null)).toEqual({ label: "No result", hasBody: false, pending: false });
    expect(summarizeResult("")).toEqual({ label: "No result", hasBody: false, pending: false });
  });

  it("does not read an absent result as running when the turn is not live", () => {
    expect(summarizeResult(undefined)).toEqual({
      label: "No output recorded",
      hasBody: false,
      pending: false,
    });
    expect(summarizeResult(undefined, false, false).pending).toBe(false);
  });

  it("says a failure failed, with its words where there are any", () => {
    expect(summarizeResult("ENOENT", true).label).toBe("Failed · ENOENT");
    expect(summarizeResult({ message: "not a project admin" }, true).label).toBe(
      "Failed · not a project admin",
    );
  });

  it("says a failure failed when there are no words at all", () => {
    expect(summarizeResult(null, true).label).toBe("Failed");
    expect(summarizeResult({}, true).label).toBe("Failed");
  });

  it("shortens a long error and says it shortened it", () => {
    const label = summarizeResult("E".repeat(400), true).label;
    expect(label.length).toBeLessThan(160);
    expect(label.endsWith("…")).toBe(true);
  });

  it("flattens the whitespace out of an error rather than letting it own three lines", () => {
    expect(summarizeResult("bad\n\n  input\n", true).label).toBe("Failed · bad input");
  });

  it("offers a body only where there is one", () => {
    expect(summarizeResult({ a: 1 }).hasBody).toBe(true);
    expect(summarizeResult([]).hasBody).toBe(true);
    expect(summarizeResult(null).hasBody).toBe(false);
    expect(summarizeResult(undefined).hasBody).toBe(false);
    expect(summarizeResult(7).hasBody).toBe(false);
  });
});

describe("nothing about the tool changes the answer", () => {
  it("summarizes {returned: 0} as one field, like any other one-field object", () => {
    expect(summarizeResult({ returned: 0 }).label).toBe(summarizeResult({ anything: 0 }).label);
    expect(summarizeResult({ returned: 0 }).label).toBe("Object · 1 field");
  });

  it("takes no tool name, so no caller can make it special-case one", () => {
    // The signature is the guard: the value, whether it is an error, and whether the turn is live.
    // None of the three is a name, and there is nowhere to pass one.
    expect(summarizeResult.length).toBe(3);
  });

  it("reads `runs: []` as a field and not as an emptiness", () => {
    expect(summarizeResult({ runs: [], returned: 0, limit: 200, hasMore: false }).label).toBe(
      "Object · 4 fields",
    );
  });
});

describe("the body a reader opens onto", () => {
  it("is pretty-printed, so keys sit on their own lines", () => {
    expect(formatResultBody({ project: { slug: "erp" } })).toBe(
      '{\n  "project": {\n    "slug": "erp"\n  }\n}',
    );
  });

  it("is the whole value however long it is", () => {
    expect(formatResultBody({ note: "x".repeat(5_000) })).toContain("x".repeat(5_000));
  });

  it("hands a string back as the string, not as a quoted one", () => {
    expect(formatResultBody("plain words")).toBe("plain words");
  });

  it("survives a value JSON cannot take", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatResultBody(cyclic)).not.toThrow();
    expect(formatResultBody(cyclic).length).toBeGreaterThan(0);
  });
});

describe("what arrives from the wire", () => {
  it("reads a serialized object back as the object", () => {
    expect(decodeToolOutput('{"project":{"slug":"erp"}}')).toEqual({ project: { slug: "erp" } });
    expect(summarizeResult(decodeToolOutput('{"project":{"slug":"erp"}}')).label).toBe(
      "Object · 1 field",
    );
  });

  it("reads a serialized empty array back as an empty array", () => {
    expect(summarizeResult(decodeToolOutput("[]")).label).toBe("Array · 0 items");
  });

  it("reads what the accumulator writes for a null result as no result", () => {
    // core `assistant/transcript-entry.ts` writes `JSON.stringify(ev.result ?? '')` — two quotes.
    expect(summarizeResult(decodeToolOutput('""')).label).toBe("No result");
  });

  it("reads a capture of nothing as no result rather than as an empty answer", () => {
    expect(decodeToolOutput("")).toBeNull();
    expect(summarizeResult(decodeToolOutput("")).label).toBe("No result");
  });

  it("leaves prose as prose rather than failing a parse on it", () => {
    expect(decodeToolOutput("three issues, one blocked")).toBe("three issues, one blocked");
    expect(summarizeResult(decodeToolOutput("three issues, one blocked")).label).toBe(
      "Text · 25 characters",
    );
  });

  it("leaves a string that only looks like JSON alone when it will not parse", () => {
    expect(decodeToolOutput('{"unclosed": ')).toBe('{"unclosed": ');
  });

  it("passes a value that never was a string straight through", () => {
    const v = { a: 1 };
    expect(decodeToolOutput(v)).toBe(v);
    expect(decodeToolOutput(undefined)).toBeUndefined();
  });

  it("pretty-prints what it decoded, rather than handing back the minified line", () => {
    expect(formatResultBody(decodeToolOutput('{"project":{"slug":"erp"}}'))).toContain('\n  "project"');
  });
});
