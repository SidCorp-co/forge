import { describe, expect, it } from "vitest";
import { productCopy } from "@/lib/i18n/product-copy";
import { summarizeResult } from "./result-summary";

const t = productCopy("en");

// A failed tool call names its reason in the turn (REQ-30 BC-3; forge-dev 2026-10-08, REQ-36's
// ba_draw_mockup read only "Failed" because a thrown chat tool answers `{ error }`, not `message`).
describe("summarizeResult on a failed call", () => {
  it("names a refusal's message", () => {
    const r = summarizeResult({ code: "SUGGESTION_BASE_STALE", message: "refused, nothing written: stale" }, true, false, t);
    expect(r.label).toBe("Failed · refused, nothing written: stale");
  });

  it("names the { error } a thrown chat tool answers", () => {
    const r = summarizeResult({ error: "MOCKUP_TYPE_INVALID: shapes.9.from — an arrow end is { id }" }, true, false, t);
    expect(r.label).toBe("Failed · MOCKUP_TYPE_INVALID: shapes.9.from — an arrow end is { id }");
  });

  it("names an { error: { message } } envelope", () => {
    const r = summarizeResult({ error: { code: "X", message: "why it failed" } }, true, false, t);
    expect(r.label).toBe("Failed · why it failed");
  });

  it("says only Failed when nothing names a reason", () => {
    expect(summarizeResult({ error: "" }, true, false, t).label).toBe("Failed");
    expect(summarizeResult(null, true, false, t).label).toBe("Failed");
  });
});
