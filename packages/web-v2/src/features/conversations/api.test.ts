import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ apiClient: vi.fn(async () => ({})), apiClientList: vi.fn(), apiPutBytes: vi.fn() }));
vi.mock("@/lib/api/client", () => client);

const { conversationsApi } = await import("./api");

beforeEach(() => client.apiClient.mockClear());

describe("opening a chat", () => {
  it("sends an ecosystem scope when one was picked", async () => {
    await conversationsApi.open({ projectId: "p1", ecosystemId: "e1" });
    const [, init] = client.apiClient.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ projectId: "p1", scope: { kind: "ecosystem", ecosystemId: "e1" } });
  });

  it("sends no scope for a project chat, which is the default", async () => {
    await conversationsApi.open({ projectId: "p1" });
    const [, init] = client.apiClient.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ projectId: "p1" });
  });

  it("pins with PUT and unpins with DELETE", async () => {
    await conversationsApi.setPinned("c1", true);
    await conversationsApi.setPinned("c1", false);
    const calls = client.apiClient.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((c) => [c[0], c[1].method])).toEqual([
      ["/conversations/c1/pin", "PUT"],
      ["/conversations/c1/pin", "DELETE"],
    ]);
  });
});
