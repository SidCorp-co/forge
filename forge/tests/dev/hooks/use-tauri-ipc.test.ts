import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("useTauriIPC / invoke", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("in browser env (no Tauri): returns null and logs warning with command name", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { invoke } = await import("@/hooks/use-tauri-ipc");
    const result = await invoke("some_cmd", { key: "val" });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("[mock IPC] some_cmd", { key: "val" });
  });

  it("in browser env: return type is T | null (returns null)", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { invoke } = await import("@/hooks/use-tauri-ipc");
    const result: string | null = await invoke<string>("test_cmd");

    expect(result).toBeNull();
  });

  it("in Tauri env: calls actual invoke with correct args", async () => {
    const mockInvoke = vi.fn().mockResolvedValue("ok");
    (window as any).__TAURI_INTERNALS__ = {};

    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }));

    const { invoke } = await import("@/hooks/use-tauri-ipc");
    const result = await invoke<string>("test_cmd", { a: 1 });

    expect(mockInvoke).toHaveBeenCalledWith("test_cmd", { a: 1 });
    expect(result).toBe("ok");
  });

  it("in Tauri env: error propagates correctly", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("ipc fail"));
    (window as any).__TAURI_INTERNALS__ = {};

    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }));

    const { invoke } = await import("@/hooks/use-tauri-ipc");
    await expect(invoke("bad_cmd")).rejects.toThrow("ipc fail");
    expect(mockInvoke).toHaveBeenCalledWith("bad_cmd", undefined);
  });

  it("in browser env: invoke without args logs undefined for args", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { invoke } = await import("@/hooks/use-tauri-ipc");
    await invoke("no_args_cmd");

    expect(warnSpy).toHaveBeenCalledWith("[mock IPC] no_args_cmd", undefined);
  });
});
