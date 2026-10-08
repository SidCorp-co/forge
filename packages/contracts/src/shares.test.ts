import { describe, expect, it } from "vitest";
import { ExecutionRequestSchema, ExecutionResultSchema, ExecutorDescriptorSchema } from "./report-executions.js";
import {
  SHARE_MAX_EXPIRY_DAYS,
  ShareAudienceOptionSchema,
  ShareCreateSchema,
  ShareLinkViewSchema,
  ShareTargetDescriptorSchema,
  shareStateOf,
} from "./shares.js";

describe("a share", () => {
  const make = { subjectKind: "message", subjectId: "m1", audience: "members" };
  it("expires in seven days unless told otherwise", () => {
    expect(ShareCreateSchema.parse(make).expiresInDays).toBe(7);
  });
  it("refuses an expiry past thirty days, naming the limit", () => {
    const r = ShareCreateSchema.safeParse({ ...make, expiresInDays: SHARE_MAX_EXPIRY_DAYS + 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain("within 30 days at most");
  });
  it("refuses an expiry of zero, a live subject and an unknown key", () => {
    expect(ShareCreateSchema.safeParse({ ...make, expiresInDays: 0 }).success).toBe(false);
    expect(ShareCreateSchema.safeParse({ ...make, subjectKind: "query" }).success).toBe(false);
    expect(ShareCreateSchema.safeParse({ ...make, token: "x" }).success).toBe(false);
  });
  it("refuses a target hosted by anyone but Forge", () => {
    const t = { id: "forge-link", hostedBy: "forge", audiences: ["link"] };
    expect(ShareTargetDescriptorSchema.safeParse(t).success).toBe(true);
    const r = ShareTargetDescriptorSchema.safeParse({ ...t, hostedBy: "third-party" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain("hosted by Forge");
  });
  it("shows no token or hash in the list view", () => {
    const v = {
      id: "s", projectId: "p", audience: "link", subjectKind: "message", createdBy: "u",
      createdAt: "2026-10-08T10:00:00Z", expiresAt: "2026-10-15T10:00:00Z", revokedAt: null, revokedBy: null, viewCount: 0, lastViewedAt: null,
    };
    expect(ShareLinkViewSchema.safeParse(v).success).toBe(true);
    expect(ShareLinkViewSchema.safeParse({ ...v, tokenHash: "abc" }).success).toBe(false);
  });
});

describe("the executor port", () => {
  const request = {
    language: "python", script: "print(1)", inputs: [],
    limits: { wallMs: 1000, cpu: 1, memoryMb: 256, outputBytes: 1000 },
  };
  it("takes a request with limits and no network", () => {
    expect(ExecutionRequestSchema.safeParse(request).success).toBe(true);
    expect(ExecutionRequestSchema.safeParse({ ...request, language: "ruby" }).success).toBe(false);
    expect(ExecutionRequestSchema.safeParse({ ...request, limits: { wallMs: 1000 } }).success).toBe(false);
  });
  it("refuses an adapter that declares a network", () => {
    const d = { id: "e2b", mode: "invoked", isolation: "microvm", network: "none", dataLeavesTo: "e2b", zdrEligible: false };
    expect(ExecutorDescriptorSchema.safeParse(d).success).toBe(true);
    expect(ExecutorDescriptorSchema.safeParse({ ...d, network: "egress" }).success).toBe(false);
  });
  it("returns frames and logs, never a picture", () => {
    const res = { executionId: "x", adapter: "e2b", exit: 0, durationMs: 5, frames: [], logs: { stdout: "", stderr: "" } };
    expect(ExecutionResultSchema.safeParse(res).success).toBe(true);
    expect(ExecutionResultSchema.safeParse({ ...res, image: "data:" }).success).toBe(false);
  });
});

describe("a listed share's state", () => {
  const at = Date.parse("2026-10-08T10:00:00Z");
  it("reads active before its date, expired on it, and revoked over either", () => {
    expect(shareStateOf({ revokedAt: null, expiresAt: "2026-10-09T10:00:00Z" }, at)).toBe("active");
    expect(shareStateOf({ revokedAt: null, expiresAt: "2026-10-08T10:00:00Z" }, at)).toBe("expired");
    expect(shareStateOf({ revokedAt: "2026-10-01T10:00:00Z", expiresAt: "2026-10-01T09:00:00Z" }, at)).toBe("revoked");
    expect(shareStateOf({ revokedAt: "2026-10-08T09:00:00Z", expiresAt: "2026-10-09T10:00:00Z" }, at)).toBe("revoked");
  });
  it("answers an audience open, or refused by code and sentence, and nothing looser", () => {
    expect(ShareAudienceOptionSchema.safeParse({ audience: "members", refusal: null }).success).toBe(true);
    expect(ShareAudienceOptionSchema.safeParse({ audience: "link", refusal: { code: "SHARE_EGRESS_FORBIDDEN", message: "no" } }).success).toBe(true);
    expect(ShareAudienceOptionSchema.safeParse({ audience: "link", refusal: { code: "", message: "no" } }).success).toBe(false);
    expect(ShareAudienceOptionSchema.safeParse({ audience: "link" }).success).toBe(false);
  });
});
