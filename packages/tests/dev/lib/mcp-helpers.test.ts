import { describe, it, expect } from "vitest";
import {
  isForgeServer,
  previewHeaders,
  targetHeaders,
} from "@/components/settings/mcp-server-list/helpers";
import type { McpServerConfig } from "@/lib/types";

const remoteServer: McpServerConfig = {
  type: "http",
  url: "https://core.example.com/mcp",
  enabled: true,
};

describe("targetHeaders", () => {
  it("merges device token, project slug, and sentry project", () => {
    const headers = targetHeaders(remoteServer, "abcdefgh", "demo-proj", "sentry-x");
    expect(headers.Authorization).toBe("Bearer abcdefgh");
    expect(headers["X-Forge-Project-Slug"]).toBe("demo-proj");
    expect(headers["X-Sentry-Project"]).toBe("sentry-x");
  });

  it("preserves caller-supplied headers", () => {
    const server: McpServerConfig = {
      ...remoteServer,
      headers: { Authorization: "Bearer custom", "X-Trace": "yes" },
    };
    const headers = targetHeaders(server, "ignored", "demo", undefined);
    expect(headers.Authorization).toBe("Bearer custom");
    expect(headers["X-Trace"]).toBe("yes");
    expect(headers["X-Forge-Project-Slug"]).toBe("demo");
  });

  it("omits absent optional values", () => {
    const headers = targetHeaders(remoteServer, null, undefined, undefined);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Forge-Project-Slug"]).toBeUndefined();
    expect(headers["X-Sentry-Project"]).toBeUndefined();
  });
});

describe("previewHeaders", () => {
  it("redacts Authorization to last-4 tail", () => {
    const out = previewHeaders({
      Authorization: "Bearer abcdef-1234",
      "X-Forge-Project-Slug": "demo",
    });
    expect(out.Authorization).toBe("Bearer ••••1234");
    expect(out["X-Forge-Project-Slug"]).toBe("demo");
  });

  it("masks X-Device-Token entirely", () => {
    const out = previewHeaders({ "X-Device-Token": "supersecret" });
    expect(out["X-Device-Token"]).toBe("••••");
  });

  it("passes through other headers unchanged", () => {
    const out = previewHeaders({ "X-Sentry-Project": "abc" });
    expect(out["X-Sentry-Project"]).toBe("abc");
  });
});

describe("isForgeServer", () => {
  it("matches by name 'forge'", () => {
    expect(isForgeServer("forge")).toBe(true);
  });

  it("matches by URL suffix /mcp", () => {
    expect(isForgeServer("anything", "https://core.example.com/mcp")).toBe(true);
    expect(isForgeServer("anything", "https://core.example.com/mcp/")).toBe(true);
  });

  it("rejects unrelated names + URLs", () => {
    expect(isForgeServer("other", "https://example.com/")).toBe(false);
  });
});
