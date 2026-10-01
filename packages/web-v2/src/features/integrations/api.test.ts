import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  apiClient: vi.fn(async () => ({})),
  apiClientList: vi.fn(),
  apiPutBytes: vi.fn(),
}));
vi.mock("@/lib/api/client", () => client);

const { integrationsApi } = await import("./api");

beforeEach(() => client.apiClient.mockClear());

describe("disconnecting a binding", () => {
  // A binding with no binding-v1 form answers its document read with BINDING_NOT_REPRESENTABLE,
  // so a remove that reads the document first can never disconnect it.
  it("is one DELETE at the listed revision, with no document read before it", async () => {
    await integrationsApi.remove("p1", { id: "b/1", revision: 4 });
    const calls = client.apiClient.mock.calls as unknown as Array<[string, RequestInit?]>;
    expect(calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/projects/p1/bindings/b%2F1", "DELETE"],
    ]);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({ baseRevision: 4 });
  });
});
