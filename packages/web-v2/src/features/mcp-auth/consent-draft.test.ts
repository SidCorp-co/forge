import type { McpConsentView } from "@forge/contracts/mcp-auth";
import { describe, expect, it } from "vitest";
import { allowDecision, denyDecision, draftFor, offeredPermissions, requestFrom } from "./consent-draft";

const view: McpConsentView = {
  client: { id: "c1", name: "Claude Code", redirectHost: "127.0.0.1:43123", registeredAt: "2026-10-16T00:00:00Z" },
  requestedScopes: ["read", "write"],
  menu: { permissions: ["issues:read", "account:read"], accountOnly: ["account:read"], explicit: ["approve"], full: "*" },
};
const request = requestFrom(
  new URLSearchParams({ client_id: "c1", redirect_uri: "http://127.0.0.1:43123/cb", state: "s", reauth: "ok" }),
);

describe("the consent page's picks", () => {
  it("keeps only the OAuth request's own parameters", () => {
    expect(request).toEqual({ client_id: "c1", redirect_uri: "http://127.0.0.1:43123/cb", state: "s" });
  });

  it("chooses no reach for the person: allowing is refused until each is picked", () => {
    const { errors, decision } = allowDecision(draftFor(view), view, request);
    expect(decision).toBeNull();
    expect(errors).toEqual({ reach: "auth.mcpConsent.err.reach", permissions: "auth.mcpConsent.err.grant" });
  });

  it("refuses chosen projects with none picked, and named permissions with none picked", () => {
    const draft = { ...draftFor(view), reach: "chosen" as const, grantMode: "named" as const };
    expect(allowDecision(draft, view, request).errors).toEqual({
      reach: "auth.mcpConsent.err.projects",
      permissions: "auth.mcpConsent.err.permissions",
    });
  });

  it("offers no account permission to a grant fenced to projects, and sends none it held", () => {
    expect(offeredPermissions(view, "chosen")).toEqual(["issues:read", "approve"]);
    const draft = {
      ...draftFor(view),
      reach: "chosen" as const,
      projectIds: ["p1"],
      grantMode: "named" as const,
      permissions: ["account:read", "issues:read"],
    };
    expect(allowDecision(draft, view, request).decision).toMatchObject({
      project_ids: ["p1"],
      permissions: ["issues:read"],
    });
  });

  it("sends full access as the menu's own name, every project as null", () => {
    const draft = { ...draftFor(view), reach: "all" as const, grantMode: "full" as const };
    expect(allowDecision(draft, view, request).decision).toEqual({
      ...request,
      decision: "allow",
      project_ids: null,
      permissions: ["*"],
      scopes: ["read", "write"],
    });
  });

  it("refuses a grant with no scope left", () => {
    const draft = { ...draftFor(view), reach: "all" as const, grantMode: "full" as const, scopes: [] };
    expect(allowDecision(draft, view, request).errors).toEqual({ scopes: "auth.mcpConsent.err.scopes" });
  });

  it("denies with the request alone", () => {
    expect(denyDecision(request)).toEqual({ ...request, decision: "deny" });
  });
});
