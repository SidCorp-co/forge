import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------- module mocks (hoisted by vitest) ----------

const mockRequest = vi.fn();
vi.mock("@/lib/api/client", () => ({
  request: (...args: any[]) => mockRequest(...(args as [string, RequestInit?])),
}));

const mockLogout = vi.fn().mockResolvedValue(undefined);
vi.mock("@/hooks/use-logout", () => ({
  useLogout: () => mockLogout,
}));

// useAuth is reconfigured per branch by mutating this object.
const authState: { deviceId: string | null; coreUrl: string; token: string; phase: string } = {
  deviceId: null,
  coreUrl: "http://localhost:8080",
  token: "tok",
  phase: "unauthenticated",
};
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/stores/auth-store", () => {
  const setDeviceId = vi.fn();
  return {
    useAuthStore: {
      getState: () => ({ setDeviceId }),
    },
  };
});

vi.mock("@/hooks/use-tauri-ipc", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "pick_directory") return null;
    if (cmd === "save_config") return undefined;
    if (cmd === "ensure_directory") return undefined;
    return null;
  }),
}));

vi.mock("@/lib/skill-sync", () => ({
  syncAllProjectSkills: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/hooks/use-auto-updater", () => ({
  useAutoUpdater: () => ({
    updateAvailable: false,
    downloading: false,
    readyToRestart: false,
    checking: false,
    error: null,
    version: null,
    progress: 0,
    installUpdate: vi.fn(),
    restartApp: vi.fn(),
    checkForUpdate: vi.fn(),
  }),
}));

// app-store: one project with a documentId so the paired card's project-row
// list renders. patchDeviceSettings is unused in our assertions but the
// Settings page subscribes to it.
const patchDeviceSettings = vi.fn();
vi.mock("@/stores/app-store", () => {
  const state = {
    wsConnected: true,
    deviceSettings: {
      projects: {
        "proj-a": { slug: "proj-a", documentId: "doc-a" },
      },
      projectsRoot: undefined,
      skillLibrary: {},
      mcpLibrary: {},
    },
    runnerBindings: {} as Record<string, { runnerId: string; status: string }>,
    patchDeviceSettings,
  };
  const useAppStore: any = (sel?: (s: any) => any) => (sel ? sel(state) : state);
  useAppStore.getState = () => state;
  return { useAppStore };
});

// Tauri's app module is only loaded for the version label — return a stub.
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));

// ---------- shared helpers ----------

async function renderSettings() {
  const { Settings } = await import("@/pages/app/Settings");
  return render(<Settings />);
}

describe("Settings — PairDeviceCard branches", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockLogout.mockReset();
    mockLogout.mockResolvedValue(undefined);
  });

  it("Branch A — unpaired: renders the pair form and not the paired card", async () => {
    authState.deviceId = null;
    authState.phase = "unauthenticated";

    await renderSettings();

    expect(screen.getByPlaceholderText(/QN-XXXX-XXXX/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Pair$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Device paired/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke this device/i })).not.toBeInTheDocument();
  });

  it("Branch B — paired + successful revoke: calls DELETE /devices/:id and triggers logout", async () => {
    authState.deviceId = "dev-1";
    authState.phase = "authenticated";
    mockRequest.mockResolvedValueOnce({});

    await renderSettings();

    expect(screen.getByText(/Device paired/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/QN-XXXX-XXXX/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Revoke this device/i }));
    const confirmBtn = await screen.findByRole("button", { name: /Yes, revoke/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith("/devices/dev-1", { method: "DELETE" });
    });
    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("Branch C — paired + server 500: keeps error visible, Retry + Force buttons appear, logout NOT called", async () => {
    authState.deviceId = "dev-1";
    authState.phase = "authenticated";
    mockRequest.mockRejectedValueOnce(new Error("API error: 500 Internal Server Error"));

    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /Revoke this device/i }));
    const confirmBtn = await screen.findByRole("button", { name: /Yes, revoke/i });
    fireEvent.click(confirmBtn);

    await screen.findByText(/Could not revoke device/i);

    // Logout must not have fired — the modal stays open for retry.
    expect(mockLogout).not.toHaveBeenCalled();

    // Retry + Force-logout escape hatches are now visible.
    expect(screen.getByRole("button", { name: /^Retry$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Force local logout anyway/i }),
    ).toBeInTheDocument();
  });

  it("Branch D — server 404 is treated as success (already revoked) and proceeds to logout", async () => {
    authState.deviceId = "dev-1";
    authState.phase = "authenticated";
    mockRequest.mockRejectedValueOnce(new Error("API error: 404 Not Found"));

    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: /Revoke this device/i }));
    const confirmBtn = await screen.findByRole("button", { name: /Yes, revoke/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText(/Could not revoke device/i)).not.toBeInTheDocument();
  });
});
