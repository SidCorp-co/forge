import { retiredSnapshotKeySentence } from "@forge/contracts/ui-actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient } from "./client";
import { formatApiError } from "./error";

describe("formatApiError reads an instant in a refusal as every screen does (REQ-32 BC-17)", () => {
  it("never prints the ISO a refusal carries", () => {
    const line = formatApiError(new ApiError(422, "first run 2026-10-03T20:00:00.000Z is in the past", "SCHEDULE_REFUSED"));
    expect(line).toMatch(/^first run .+ is in the past$/);
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}|T20:00/);
  });
});

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

/**
 * ISS-467: picking Approved on an issue with no design toasted core's sentence, which tells a run to
 * make a REST call; no screen records a design (judge J1 on 0.4.0-dev.222). The web says what is
 * missing, who records it and where it shows, read off the refusal's `gaps`, never its prose.
 */
describe("a move refused by the design check", () => {
  const refusedWith = (code: string, detail: string, details: Record<string, unknown>) => {
    const message = `refused, nothing written: ${code} at /status: ${detail}`;
    return {
      type: `urn:forge:refusal:${code}`,
      title: "Design record",
      status: 422,
      detail,
      code,
      message,
      error: { code, message, refusals: [{ code, path: "/status", detail, details }] },
    };
  };
  const lineFor = async (body: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/problem+json" } })),
    );
    return formatApiError(await apiClient("/issues/i1/transition", { method: "POST", body: "{}" }).catch((e: unknown) => e));
  };
  const NO_HTTP = /\b(GET|PUT|POST|PATCH|DELETE)\b|\/api\//;

  afterEach(() => vi.unstubAllGlobals());

  it("says a missing record, who records it and that no screen shows it, with no HTTP call", async () => {
    const line = await lineFor(
      refusedWith("DESIGN_RECORD_MISSING", "ISS-9 has no design. Record it (PUT /api/issues/:id/design), then move it.", {
        from: "in_progress",
        to: "approved",
        missing: ["design"],
        gaps: [{ part: "design" }],
      }),
    );
    expect(line).toBe("This issue has no design record yet. The run building it records one; no screen shows it.");
    expect(line).not.toMatch(NO_HTTP);
  });

  it("names each gap of an incomplete record by criterion number and part", async () => {
    const line = await lineFor(
      refusedWith(
        "DESIGN_RECORD_INCOMPLETE",
        "The design of ISS-9 lacks criterion 3: no class, pattern or proof (written or reworded since); criterion 4: DESIGN_PATTERN_UNCATALOGUED; modules: none named. Record it again (PUT /api/issues/:id/design), then move it.",
        {
          from: "in_progress",
          to: "approved",
          missing: ["criterion 3: no class, pattern or proof", "criterion 4: DESIGN_PATTERN_UNCATALOGUED", "modules: none named"],
          gaps: [{ part: "criterion", criterion: 3 }, { part: "criterion", criterion: 4 }, { part: "modules" }],
        },
      ),
    );
    expect(line).toBe("The design record lacks criteria 3, 4 and modules. The run building it records it again; no screen shows it.");
    expect(line).not.toMatch(NO_HTTP);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  it("names one criterion, and an issue with no criteria, in the same words", async () => {
    const one = await lineFor(
      refusedWith("DESIGN_RECORD_INCOMPLETE", "x (PUT /api/issues/:id/design)", { gaps: [{ part: "criterion", criterion: 2 }] }),
    );
    expect(one).toBe("The design record lacks criterion 2. The run building it records it again; no screen shows it.");
    const none = await lineFor(refusedWith("DESIGN_RECORD_INCOMPLETE", "x (PUT /api/issues/:id/design)", { gaps: [{ part: "criteria" }] }));
    expect(none).toBe("The design record lacks criteria. The run building it records it again; no screen shows it.");
  });

  it("still keeps the HTTP call out where the refusal names no gaps", async () => {
    const line = await lineFor(refusedWith("DESIGN_RECORD_INCOMPLETE", "x (PUT /api/issues/:id/design)", {}));
    expect(line).toBe("The design record is incomplete. The run building it records it again; no screen shows it.");
  });
});
