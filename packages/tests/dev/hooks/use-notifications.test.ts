import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The hook itself wraps the pure `notify` function in `useCallback`. Tests
// exercise `notify` directly (no renderHook) — the wiring is trivial and the
// browser-vs-Tauri branch is what matters. See vitest.config.ts for why
// renderHook is currently off-limits in this package.

describe("notify", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("@tauri-apps/plugin-notification");
  });

  it("browser env: shows notification immediately when permission is already granted", async () => {
    const MockNotification = vi.fn();
    (MockNotification as any).permission = "granted";
    (MockNotification as any).requestPermission = vi.fn();
    vi.stubGlobal("Notification", MockNotification);

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Hello" });

    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(MockNotification).toHaveBeenCalledWith("Test", { body: "Hello" });
  });

  it("browser env: requests permission first when status is 'default', then shows notification", async () => {
    const MockNotification = vi.fn();
    (MockNotification as any).permission = "default";
    (MockNotification as any).requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", MockNotification);

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Hello" });

    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(MockNotification).toHaveBeenCalledWith("Test", { body: "Hello" });
  });

  it("browser env: does not show notification when permission is denied", async () => {
    const MockNotification = vi.fn();
    (MockNotification as any).permission = "denied";
    (MockNotification as any).requestPermission = vi.fn();
    vi.stubGlobal("Notification", MockNotification);

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Hello" });

    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it("browser env: does not show notification when requestPermission returns denied", async () => {
    const MockNotification = vi.fn();
    (MockNotification as any).permission = "default";
    (MockNotification as any).requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", MockNotification);

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Hello" });

    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it("Tauri env: checks permission before calling sendNotification", async () => {
    (window as any).__TAURI_INTERNALS__ = {};

    const mockSend = vi.fn();
    const mockIsPermissionGranted = vi.fn().mockResolvedValue(true);
    const mockRequestPermission = vi.fn();
    vi.doMock("@tauri-apps/plugin-notification", () => ({
      sendNotification: mockSend,
      isPermissionGranted: mockIsPermissionGranted,
      requestPermission: mockRequestPermission,
    }));

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Body" });

    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ title: "Test", body: "Body" });
  });

  it("Tauri env: requests permission when not granted, then sends", async () => {
    (window as any).__TAURI_INTERNALS__ = {};

    const mockSend = vi.fn();
    const mockIsPermissionGranted = vi.fn().mockResolvedValue(false);
    const mockRequestPermission = vi.fn().mockResolvedValue("granted");
    vi.doMock("@tauri-apps/plugin-notification", () => ({
      sendNotification: mockSend,
      isPermissionGranted: mockIsPermissionGranted,
      requestPermission: mockRequestPermission,
    }));

    const { notify } = await import("@/hooks/use-notifications");
    await notify({ title: "Test", body: "Body" });

    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({ title: "Test", body: "Body" });
  });
});
