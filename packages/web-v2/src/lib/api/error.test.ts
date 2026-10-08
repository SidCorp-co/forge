import { retiredSnapshotKeySentence } from "@forge/contracts/ui-actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient } from "./client";
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

/**
 * ISS-441: a tab loaded before the page item still sends `uiSnapshot.issueKey`. Core refuses it under
 * CONVERSATION_PAGE_OUT_OF_DATE, the body below being the one it sends. A tab runs the client and
 * formatter it was loaded with, and at dev.193 (bc3764a27) `client.ts` and `error.ts` were byte for
 * byte these, so this is that tab's handling: the line under the failed message must be core's
 * sentence telling the person to reload, never the fixed "Invalid input" BAD_REQUEST prints.
 */
describe("a message from a tab loaded before the page item", () => {
  const detail = retiredSnapshotKeySentence("issueKey");
  const message = `refused, nothing written: CONVERSATION_PAGE_OUT_OF_DATE at /uiSnapshot/issueKey: ${detail}`;
  const body = {
    type: "urn:forge:refusal:CONVERSATION_PAGE_OUT_OF_DATE",
    title: "Conversation page out of date",
    status: 400,
    detail,
    code: "CONVERSATION_PAGE_OUT_OF_DATE",
    message,
    error: {
      code: "CONVERSATION_PAGE_OUT_OF_DATE",
      message,
      refusals: [{ code: "CONVERSATION_PAGE_OUT_OF_DATE", path: "/uiSnapshot/issueKey", detail }],
    },
  };

  afterEach(() => vi.unstubAllGlobals());

  it("prints core's sentence, which tells the person to reload the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/problem+json" } })),
    );
    const err = await apiClient("/conversations/x/messages", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const line = formatApiError(err);
    expect(line).toBe(detail);
    expect(line).toContain("Reload the page");
    expect(line).not.toContain("Invalid input");
  });
});
