// FB-128: a connection and the projects it serves are written by one call. The form used to create
// the connection, then write each binding, then remove the connection when a binding was refused:
// three calls, with a connection left behind whenever the remove itself failed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "@/test/render";
import { bindConnection, createIntegration } from "./bind-actions";

afterEach(() => vi.unstubAllGlobals());

describe("creating and binding a connection", () => {
  it("sends the connection and every project's binding in one call, and writes nothing else", async () => {
    const calls = fakeCore((call) =>
      call.method === "POST" && call.path === "/integration-connections"
        ? { status: 201, body: { connection: { id: "c1" }, bindings: [] } }
        : undefined,
    );

    await createIntegration(
      "p1",
      { provider: "sentry", role: "service", config: { host: "https://sentry.io" }, secrets: { authToken: "t" } },
      ["p2", "p1"],
    );

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/integration-connections",
        body: {
          provider: "sentry",
          config: { host: "https://sentry.io" },
          secrets: { authToken: "t" },
          bindings: [
            { projectId: "p1", role: "service", target: { provider: "sentry" } },
            { projectId: "p2", role: "service", target: { provider: "sentry" } },
          ],
        },
      },
    ]);
  });

  it("binds an existing connection through the same one-call bind, leaving the slot to core", async () => {
    const calls = fakeCore((call) =>
      call.method === "POST" && call.path === "/integration-connections/c1/bindings" ? { body: { bindings: [] } } : undefined,
    );

    await bindConnection("p1", {
      connectionId: "c1",
      provider: "github",
      role: "service",
      binding: { owner: "SidCorp-co", repo: "forge", installationId: 9 },
      agentAccess: "all",
    });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/integration-connections/c1/bindings",
        body: {
          bindings: [
            {
              projectId: "p1",
              role: "service",
              target: { provider: "github", owner: "SidCorp-co", repo: "forge", installationId: 9 },
              agentAccess: "all",
            },
          ],
        },
      },
    ]);
  });
});
