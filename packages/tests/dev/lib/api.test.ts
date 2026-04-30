import { describe, it, expect, vi, beforeEach } from "vitest";
import { configureApi, getProjects, updateTask } from "@/lib/api";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("api client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    configureApi("http://localhost:8080", "test-token");
  });

  it("GET request: correct URL and auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "1", name: "Proj", slug: "proj" }] }),
    });

    await getProjects();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/projects",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("PATCH request: correct body serialization", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: "task-doc-1" } }),
    });

    await updateTask("task-doc-1", { agentStatus: "running" } as any);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/tasks/task-doc-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ agentStatus: "running" }),
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

  it("configureApi: updates base URL and token", async () => {
    configureApi("http://other:9999/", "new-token");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await getProjects();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://other:9999/api/projects",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer new-token",
        }),
      }),
    );
  });
});
