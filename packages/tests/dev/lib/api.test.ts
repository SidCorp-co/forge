import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAuthStore, _resetAuthStoreForTest } from "@/stores/auth-store";
import { getProjects, updateTask } from "@/lib/api";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function setAuth(coreUrl: string, token: string): void {
  useAuthStore.setState({
    phase: "authenticated",
    coreUrl,
    token,
    deviceId: "dev-1",
  } as any);
}

describe("api client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _resetAuthStoreForTest();
    setAuth("http://localhost:8080", "test-token");
  });

  it("GET request: correct URL and auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 1, name: "Proj" }] }),
    });

    await getProjects();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/projects?populate=*",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("POST/PUT request: correct body serialization", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: 1 } }),
    });

    await updateTask("task-doc-1", { agentStatus: "running" } as any);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/tasks/task-doc-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ data: { agentStatus: "running" } }),
      }),
    );
  });

  it("error response: throws with status info", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(getProjects()).rejects.toThrow("API error: 404 Not Found");
  });

  it("auth-store updates: subsequent requests pick up the new base URL and token", async () => {
    setAuth("http://other:9999/", "new-token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await getProjects();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://other:9999/api/projects?populate=*",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer new-token",
        }),
      }),
    );
  });
});
