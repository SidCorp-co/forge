import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: vi.fn(async (path: string) => {
    seen.push(path);
    return { runs: [] };
  }),
}));

const seen: string[] = [];

describe("features/agents/api", () => {
  it("passes a path the client has not already prefixed", async () => {
    const { agentsApi } = await import("./api");
    await agentsApi.runSessions("proj-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("/projects/proj-1/run-sessions");
    expect(seen[0].startsWith("/api/")).toBe(false);
  });
});
