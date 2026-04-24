import { useState, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { invoke } from "@/hooks/use-tauri-ipc";
import { setDeviceProjectsRoot } from "@/lib/api";
import { PageShell } from "@/components/ui/page-shell";
import { FormInput } from "@/components/ui/form-input";
import { useLogout } from "@/hooks/use-logout";
import { useAutoUpdater } from "@/hooks/use-auto-updater";

export function Settings() {
  const { config, setConfig, wsConnected } = useAppStore();
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

  const [projectsRoot, setProjectsRoot] = useState(config.projectsRoot ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleBrowse() {
    try {
      const selected = await invoke<string | null>("pick_directory");
      if (selected) setProjectsRoot(selected);
    } catch {
      // Fallback: user types manually
    }
  }

  async function handleSave() {
    const trimmed = projectsRoot.trim();
    if (!trimmed) {
      // Clear the setting — will use default ~/forge-projects
      const updated = { ...config, projectsRoot: undefined };
      setConfig(updated);
      await invoke("save_config", { config: updated });
      if (config.deviceId) setDeviceProjectsRoot(config.deviceId, null).catch(() => {});
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

    const updated = { ...config, projectsRoot: trimmed };
    setConfig(updated);
    await invoke("save_config", { config: updated });
    if (config.deviceId) setDeviceProjectsRoot(config.deviceId, trimmed).catch(() => {});
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
              {wsConnected ? "Connected to" : "Disconnected from"} {config.coreUrl}
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
    </PageShell>
  );
}
