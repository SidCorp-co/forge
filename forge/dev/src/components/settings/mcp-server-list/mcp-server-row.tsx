import type { McpServerConfig } from "@/lib/types";
import { Button } from "@/components/ui";
import { isRemote, serverSubtitle } from "./helpers";

type InstallStatus = "ok" | "err" | undefined;

interface ToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

function Toggle({ enabled, onToggle }: ToggleProps) {
  return (
    <button
      onClick={onToggle}
      className={`h-4 w-8 rounded-full transition-colors ${enabled ? "bg-green-500" : "bg-gray-300"}`}
    >
      <span
        className={`block h-3 w-3 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

interface InstallButtonProps {
  status: InstallStatus;
  onClick: () => void;
}

function InstallButton({ status, onClick }: InstallButtonProps) {
  const label =
    status === "ok" ? "Installed" : status === "err" ? "Failed" : "Install to CLI";
  const colorClass =
    status === "ok"
      ? "text-green-600"
      : status === "err"
        ? "text-red-500"
        : "text-blue-500 hover:bg-blue-50";
  return (
    <button onClick={onClick} className={`rounded px-2 py-1 text-xs ${colorClass}`}>
      {label}
    </button>
  );
}

// --- Forge built-in row ---

interface ForgeServerRowProps {
  server: McpServerConfig;
  installStatus: InstallStatus;
  onInstall: () => void;
}

export function ForgeServerRow({ server, installStatus, onInstall }: ForgeServerRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-green-500 text-[8px] text-white">
          F
        </span>
        <div>
          <p className="text-sm font-medium text-gray-800">
            forge
            <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">
              built-in
            </span>
            <span className="ml-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">
              remote
            </span>
          </p>
          <p className="text-xs text-gray-400">{server.url}</p>
        </div>
      </div>
      <div className="flex gap-1">
        <InstallButton status={installStatus} onClick={onInstall} />
      </div>
    </div>
  );
}

// --- Library server row ---

interface LibraryServerRowProps {
  name: string;
  server: McpServerConfig;
  enabled: boolean;
  installStatus: InstallStatus;
  onToggle: (enabled: boolean) => void;
  onInstall: () => void;
  onRemove: () => void;
}

export function LibraryServerRow({
  name,
  server,
  enabled,
  installStatus,
  onToggle,
  onInstall,
  onRemove,
}: LibraryServerRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center gap-3">
        <Toggle enabled={enabled} onToggle={() => onToggle(!enabled)} />
        <div>
          <p className="text-sm font-medium text-gray-800">
            {name}
            {isRemote(server) && (
              <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">
                remote
              </span>
            )}
            <span className="ml-1 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">
              library
            </span>
          </p>
          <p className="text-xs text-gray-400">{serverSubtitle(server)}</p>
        </div>
      </div>
      <div className="flex gap-1">
        <InstallButton status={installStatus} onClick={onInstall} />
        <button
          onClick={onRemove}
          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// --- Project server row ---

interface ProjectServerRowProps {
  name: string;
  server: McpServerConfig;
  installStatus: InstallStatus;
  onToggle: () => void;
  onInstall: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

export function ProjectServerRow({
  name,
  server,
  installStatus,
  onToggle,
  onInstall,
  onEdit,
  onRemove,
}: ProjectServerRowProps) {
  const enabled = server.enabled ?? true;
  return (
    <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center gap-3">
        <Toggle enabled={enabled} onToggle={onToggle} />
        <div>
          <p className="text-sm font-medium text-gray-800">
            {name}
            {isRemote(server) && (
              <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">
                remote
              </span>
            )}
          </p>
          <p className="text-xs text-gray-400">{serverSubtitle(server)}</p>
        </div>
      </div>
      <div className="flex gap-1">
        <InstallButton status={installStatus} onClick={onInstall} />
        <button
          onClick={onEdit}
          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200"
        >
          Edit
        </button>
        <button
          onClick={onRemove}
          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
