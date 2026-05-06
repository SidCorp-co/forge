import { useState, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { useAuth } from "@/hooks/useAuth";
import { useAuthStore } from "@/stores/auth-store";
import { invoke } from "@/hooks/use-tauri-ipc";
import { syncAllProjectSkills } from "@/lib/skill-sync";
import { PageShell } from "@/components/ui/page-shell";
import { FormInput } from "@/components/ui/form-input";
import { useLogout } from "@/hooks/use-logout";
import { useAutoUpdater } from "@/hooks/use-auto-updater";
import type { AppConfig } from "@/lib/types";

export function Settings() {
  const deviceSettings = useAppStore((s) => s.deviceSettings);
  const patchDeviceSettings = useAppStore((s) => s.patchDeviceSettings);
  const wsConnected = useAppStore((s) => s.wsConnected);
  const auth = useAuth();
  const logout = useLogout();
  const updater = useAutoUpdater();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch {
        setAppVersion("unknown");
      }
    })();
  }, []);

  const [projectsRoot, setProjectsRoot] = useState(deviceSettings.projectsRoot ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "error">("idle");
  const [syncMsg, setSyncMsg] = useState("");

  async function handleSyncSkills() {
    setSyncStatus("syncing");
    setSyncMsg("");
    try {
      const any = await syncAllProjectSkills(deviceSettings.projects);
      setSyncStatus("synced");
      setSyncMsg(any ? "Skills synced." : "All skills already up to date.");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch (err) {
      setSyncStatus("error");
      setSyncMsg(`Sync failed: ${err}`);
    }
  }

  async function handleBrowse() {
    try {
      const selected = await invoke<string | null>("pick_directory");
      if (selected) setProjectsRoot(selected);
    } catch {
      // Fallback: user types manually
    }
  }

  function buildAppConfig(nextProjectsRoot: string | undefined): AppConfig {
    return {
      coreUrl: auth.coreUrl ?? "",
      authToken: auth.token ?? "",
      deviceId: auth.deviceId ?? "",
      projects: deviceSettings.projects,
      projectsRoot: nextProjectsRoot,
      skillLibrary: deviceSettings.skillLibrary,
      mcpLibrary: deviceSettings.mcpLibrary,
    };
  }

  async function handleSave() {
    const trimmed = projectsRoot.trim();
    if (!trimmed) {
      // Clear the setting — will use default ~/forge-projects
      patchDeviceSettings({ projectsRoot: undefined });
      await invoke("save_config", { config: buildAppConfig(undefined) });
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
      return;
    }

    // Validate: must be an absolute path (Windows: C:\... or \\..., Unix: /...)
    setStatus("saving");
    setErrorMsg("");
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/");
    if (!isAbsolute) {
      setStatus("error");
      setErrorMsg("Projects root must be an absolute path (e.g. C:\\Users\\Admin\\forge-projects)");
      return;
    }

    // Validate: try to create the directory (mkdir -p)
    try {
      await invoke("ensure_directory", { path: trimmed });
    } catch (err) {
      setStatus("error");
      setErrorMsg(`Cannot create directory: ${err}`);
      return;
    }

    patchDeviceSettings({ projectsRoot: trimmed });
    await invoke("save_config", { config: buildAppConfig(trimmed) });
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <PageShell title="Settings">
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${wsConnected ? "bg-green-500" : "bg-red-400"}`} />
            <span className="text-sm font-medium text-gray-700">
              {wsConnected ? "Connected to" : "Disconnected from"} {auth.coreUrl ?? ""}
            </span>
          </div>
          <button
            onClick={logout}
            className="rounded bg-red-50 px-3 py-1.5 text-xs text-red-600 hover:bg-red-100"
          >
            Logout
          </button>
        </div>
      </div>

      <PairDeviceCard />


      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-gray-900">Skills</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Pull effective skill list (globals + per-project overrides) from packages/core into each project's <code className="rounded bg-gray-100 px-1 text-[10px]">.claude/skills/</code> dir.
            </p>
            {syncMsg && (
              <p
                className={`mt-2 text-xs ${
                  syncStatus === "error" ? "text-red-600" : "text-green-600"
                }`}
              >
                {syncMsg}
              </p>
            )}
          </div>
          <button
            onClick={handleSyncSkills}
            disabled={syncStatus === "syncing"}
            className="rounded bg-blue-50 px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-100 disabled:opacity-50"
          >
            {syncStatus === "syncing" ? "Syncing…" : "Sync skills now"}
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <label className="mb-1 block text-sm font-medium text-gray-700">
          Projects Root Folder
        </label>
        <div className="flex gap-2">
          <FormInput
            type="text"
            value={projectsRoot}
            onChange={(e) => setProjectsRoot(e.target.value)}
            placeholder="~/forge-projects (default)"
            className="flex-1"
          />
          <button
            onClick={handleBrowse}
            className="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-200"
          >
            Browse
          </button>
          <button
            onClick={handleSave}
            disabled={status === "saving"}
            className="shrink-0 rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {status === "saving" ? "Saving..." : "Save"}
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-400">
          Parent directory where auto-created project folders live.
          Each project gets a subfolder named after its slug.
          Leave empty to use the default (~/forge-projects).
        </p>
        {status === "saved" && (
          <p className="mt-1 text-xs font-medium text-green-600">Saved</p>
        )}
        {status === "error" && (
          <p className="mt-1 text-xs font-medium text-red-500">{errorMsg}</p>
        )}
      </div>

      {/* App version & update */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-700">App Version</h3>
            <p className="mt-0.5 text-lg font-semibold text-gray-900">
              v{appVersion || "..."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {updater.updateAvailable && !updater.downloading && !updater.readyToRestart && (
              <button
                onClick={updater.installUpdate}
                className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
              >
                Update to v{updater.version}
              </button>
            )}
            {updater.downloading && (
              <span className="text-sm text-blue-600">
                Downloading... {updater.progress}%
              </span>
            )}
            {updater.readyToRestart && (
              <button
                onClick={updater.restartApp}
                className="rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
              >
                Restart to Apply v{updater.version}
              </button>
            )}
            <button
              onClick={() => updater.checkForUpdate()}
              disabled={updater.checking}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 disabled:opacity-50"
            >
              {updater.checking ? "Checking..." : "Check for Updates"}
            </button>
          </div>
        </div>
        {updater.error && (
          <p className="mt-2 text-xs text-red-500">{updater.error}</p>
        )}
        {!updater.updateAvailable && !updater.checking && !updater.readyToRestart && !updater.error && (
          <p className="mt-1 text-xs text-gray-400">You are on the latest version.</p>
        )}
      </div>

      <p className="mt-6 text-sm text-gray-400">
        Project settings (repo path, instructions) are configured within each project page.
      </p>

      <PmAgentDeeplinkCard coreUrl={auth.coreUrl ?? ""} />
    </PageShell>
  );
}

function PmAgentDeeplinkCard({ coreUrl }: { coreUrl: string }) {
  // Desktop intentionally does not host the full PM Agent config form (per
  // ISS-22 scope — web is the canonical surface). This card surfaces the
  // deeplink so users can jump to the cloud UI without hunting for it.
  const base = coreUrl.replace(/\/api\/?$/, "").replace(/\/$/, "");
  const target = base ? `${base}/projects` : "";

  async function handleOpen() {
    if (!target) return;
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(target);
    } catch {
      window.open(target, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-medium text-gray-900">PM Agent</h3>
      <p className="mt-1 text-xs text-gray-500">
        Configure cadence, triggers, and policies in the web app. Desktop only
        surfaces escalations that need a human response.
      </p>
      <button
        type="button"
        onClick={handleOpen}
        disabled={!target}
        className="mt-3 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-black disabled:opacity-50"
      >
        Open PM Agent settings ↗
      </button>
    </div>
  );
}

function PairDeviceCard() {
  const auth = useAuth();
  const deviceSettings = useAppStore((s) => s.deviceSettings);
  const [code, setCode] = useState("");
  const [name, setName] = useState("Beta-" + (typeof navigator !== "undefined" ? navigator.platform.slice(0, 8) : "device"));
  const [status, setStatus] = useState<"idle" | "pairing" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function handlePair() {
    setStatus("pairing");
    setMsg("");
    try {
      const res = await invoke<{ deviceId: string; projectId?: string }>("pair_device", {
        coreUrl: auth.coreUrl ?? "",
        code: code.trim(),
        name: name.trim() || "device",
      });
      if (!res) throw new Error("pair_device returned no payload");
      useAuthStore.getState().setDeviceId(res.deviceId);
      // Persist the new deviceId — save_config carries the full disk-shape
      // AppConfig (auth fields + device settings).
      await invoke("save_config", {
        config: {
          coreUrl: auth.coreUrl ?? "",
          authToken: auth.token ?? "",
          deviceId: res.deviceId,
          projects: deviceSettings.projects,
          projectsRoot: deviceSettings.projectsRoot,
          skillLibrary: deviceSettings.skillLibrary,
          mcpLibrary: deviceSettings.mcpLibrary,
        },
      });
      setStatus("ok");
      setMsg(`Paired as device ${res.deviceId}`);
      setCode("");
    } catch (err) {
      setStatus("error");
      setMsg(`Pair failed: ${err}`);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
      <h3 className="text-sm font-semibold text-gray-900">Pair Device</h3>
      <p className="mt-0.5 text-xs text-gray-500">
        Paste the pairing code from <code className="rounded bg-white px-1 text-[10px]">POST /api/projects/&lt;id&gt;/devices/pairing-codes</code>.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <FormInput
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="QN-XXXX-XXXX"
          className="font-mono"
        />
        <FormInput
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="device name"
        />
        <button
          onClick={handlePair}
          disabled={status === "pairing" || !code.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "pairing" ? "Pairing..." : "Pair"}
        </button>
      </div>
      {msg && (
        <p className={`mt-2 text-xs ${status === "ok" ? "text-green-700" : "text-red-700"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}
