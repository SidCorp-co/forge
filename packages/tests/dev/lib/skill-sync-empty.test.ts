import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const requestMock = vi.fn();
const resolveMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  resolveProjectId: (...args: unknown[]) => resolveMock(...args),
}));

const { syncProjectSkills } = await import("@/lib/skill-sync");

beforeEach(() => {
  invokeMock.mockReset();
  requestMock.mockReset();
  resolveMock.mockReset();
  resolveMock.mockResolvedValue("proj-1");
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_skill_hashes") return {};
    return null;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("skill-sync empty body guard (ISS-292 follow-up)", () => {
  it("skips a dev-target skill when skillMd is empty (does not call install_skill_from_strapi)", async () => {
    requestMock.mockResolvedValueOnce([
      {
        id: "s1",
        name: "forge-plan",
        scope: "global",
        target: "dev",
        skillMd: "", // ← empty body
        files: [],
        contentHash: "abc",
      },
    ]);
    const synced = await syncProjectSkills("apiflow", "/repos/apiflow");
    expect(synced).toBe(false);
    const installCall = invokeMock.mock.calls.find(
      (c) => c[0] === "install_skill_from_strapi",
    );
    expect(installCall).toBeUndefined();
  });

  it("skips when skillMd is whitespace-only", async () => {
    requestMock.mockResolvedValueOnce([
      { id: "s1", name: "forge-code", scope: "global", target: "dev", skillMd: "   \n\t  " },
    ]);
    const synced = await syncProjectSkills("apiflow", "/repos/apiflow");
    expect(synced).toBe(false);
  });

  it("installs a dev-target skill with non-empty skillMd", async () => {
    requestMock.mockResolvedValueOnce([
      {
        id: "s1",
        name: "forge-plan",
        scope: "global",
        target: "dev",
        skillMd: "# Forge Plan\nbody...",
        files: [],
        contentHash: "abc",
      },
    ]);
    const synced = await syncProjectSkills("apiflow", "/repos/apiflow");
    expect(synced).toBe(true);
    const installCall = invokeMock.mock.calls.find(
      (c) => c[0] === "install_skill_from_strapi",
    );
    expect(installCall).toBeDefined();
  });

  it("skips a cloud-target skill with empty localGuide", async () => {
    requestMock.mockResolvedValueOnce([
      {
        id: "s2",
        name: "forge-cloud-x",
        scope: "global",
        target: "cloud",
        localGuide: "", // ← empty
      },
    ]);
    const synced = await syncProjectSkills("apiflow", "/repos/apiflow");
    expect(synced).toBe(false);
    const installCall = invokeMock.mock.calls.find(
      (c) => c[0] === "install_skill_guide",
    );
    expect(installCall).toBeUndefined();
  });
});
