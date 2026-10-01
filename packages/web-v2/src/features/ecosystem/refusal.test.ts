import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { REGISTER_STATUS } from "./api";
import { readingOf, refusalsOf } from "./refusal";
import { ecosystemRoutes } from "./routes";

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

describe("the route builders part B links to", () => {
  it("builds each ecosystem page under the project", () => {
    expect(ecosystemRoutes.register("forge")).toBe("/projects/forge/ecosystem/channel");
    expect(ecosystemRoutes.register("forge", { filter: "overdue" })).toBe(
      "/projects/forge/ecosystem/channel?status=overdue",
    );
    expect(ecosystemRoutes.register("forge", { filter: "held", ecosystem: "e1" })).toBe(
      "/projects/forge/ecosystem/channel?status=held&ecosystem=e1",
    );
    expect(ecosystemRoutes.document("forge", "FP-CN-1")).toBe("/projects/forge/ecosystem/channel/FP-CN-1");
    expect(ecosystemRoutes.compose("forge", { inReplyTo: "FP-CN-1" })).toBe(
      "/projects/forge/ecosystem/channel/new?inReplyTo=FP-CN-1",
    );
    expect(ecosystemRoutes.contracts("forge")).toBe("/projects/forge/ecosystem/contracts");
    expect(ecosystemRoutes.contract("forge-plugin", "forge-api", "p1")).toBe(
      "/projects/forge-plugin/ecosystem/contracts/forge-api?provider=p1",
    );
    expect(ecosystemRoutes.apiPage("forge")).toBe("/projects/forge/ecosystem/api");
  });

  it("maps every register filter to a status core's register defines", () => {
    expect(REGISTER_STATUS).toEqual({
      awaiting: "open",
      overdue: "overdue",
      held: "held",
      answered: "answered",
      closed: "closed",
    });
  });
});
