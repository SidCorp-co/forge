import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { readingOf, readRefusal, refusalsOf } from "./refusals";

describe("refusalsOf names every refusal core sends, in either shape", () => {
  it("reads the document envelope a 422 carries, which has no top-level code", () => {
    const err = new ApiError(422, "Unprocessable Entity", undefined, undefined, {
      error: {
        code: "HOLD_NOT_AUTHORISED",
        message: "refused, nothing written: HOLD_NOT_AUTHORISED at /by",
        refusals: [{ code: "HOLD_NOT_AUTHORISED", path: "/by", detail: "a viewer holds nothing" }],
      },
    });
    expect(refusalsOf(err)).toEqual([
      { code: "HOLD_NOT_AUTHORISED", path: "/by", detail: "a viewer holds nothing" },
    ]);
  });

  it("reads the refusal a 403 carries in details", () => {
    const refusal = { code: "CHANNEL_WRITE_NOT_AUTHORISED", path: "/from", detail: "a viewer reads only" };
    const err = new ApiError(403, "a viewer reads only", "CHANNEL_WRITE_NOT_AUTHORISED", { refusals: [refusal] });
    expect(refusalsOf(err)).toEqual([refusal]);
  });

  it("names an HTTP refusal by its own code, never by a generic sentence", () => {
    const err = new ApiError(403, "option approve carries authority admin", "QUESTION_AUTHORITY_REQUIRED");
    expect(refusalsOf(err)).toEqual([
      { code: "QUESTION_AUTHORITY_REQUIRED", path: "", detail: "option approve carries authority admin" },
    ]);
  });

  it("names a failure that carries no code by its status, so it is never nothing", () => {
    expect(refusalsOf(new ApiError(502, "Bad Gateway"))).toEqual([
      { code: "HTTP_502", path: "", detail: "Bad Gateway" },
    ]);
    expect(refusalsOf(new TypeError("Failed to fetch"))[0]?.code).toBe("REQUEST_FAILED");
  });
});

describe("readingOf keeps a failed read apart from an empty one", () => {
  it("reads an error as unread, even when stale data is cached", () => {
    const r = readingOf({ data: { documents: [] }, error: new ApiError(500, "boom"), isError: true });
    expect(r.kind).toBe("unread");
  });

  it("reads an empty list as read", () => {
    expect(readingOf({ data: [], error: null, isError: false })).toEqual({ kind: "read", value: [] });
  });
});

describe("readRefusal words a refusal for a person", () => {
  it("reads one it has no wording for as core wrote it, under its path", () => {
    const r = { code: "SCHEMA_VIOLATION", path: "/qa", detail: "expected one of self|independent" };
    expect(readRefusal(r)).toEqual({ code: "SCHEMA_VIOLATION", where: "/qa", sentence: r.detail });
  });

  it("names no field for a refusal of the whole request", () => {
    expect(readRefusal({ code: "HTTP_500", path: "", detail: "request failed (500)" }).where).toBeNull();
  });
});
