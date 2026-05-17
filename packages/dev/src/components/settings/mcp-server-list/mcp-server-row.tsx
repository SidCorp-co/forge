import { useMemo, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { useMcpConnectionStatus, type McpConnStatus } from "@/hooks/use-mcp-connection-status";
import { McpCliInstallPicker } from "@/components/settings/mcp-cli-install-picker";
import { McpToolsInspector } from "@/components/settings/mcp-tools-inspector";
import { isRemote, serverSubtitle, targetHeaders } from "./helpers";

interface ToggleProps {
  enabled: boolean;
  onToggle: () => void;
  label?: string;
}

function Toggle({ enabled, onToggle, label }: ToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-label={label ?? (enabled ? "Disable server" : "Enable server")}
      aria-pressed={enabled}
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

interface StatusDotProps {
  status: McpConnStatus;
  remote: boolean;
}

function StatusDot({ status, remote }: StatusDotProps) {
  const color =
    status === "ok"
      ? "bg-green-500"
      : status === "degraded"
        ? "bg-amber-500"
        : status === "unreachable"
          ? "bg-red-500"
          : status === "pinging"
            ? "bg-gray-400 animate-pulse"
            : "bg-gray-300";
  const tooltip = remote
    ? `Connection: ${status}`
    : "Local server — cannot ping from the desktop UI";
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}

interface InspectorChevronProps {
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
}

function InspectorChevron({ expanded, onToggle, controlsId }: InspectorChevronProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controlsId}
      aria-label={expanded ? "Hide tools" : "Show tools"}
      className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200"
    >
      <span aria-hidden>{expanded ? "▾" : "▸"}</span> Tools
    </button>
  );
}

interface BaseRowMeta {
  name: string;
  server: McpServerConfig;
  deviceToken: string | null;
  projectSlug: string | undefined;
  sentryProject: string | undefined;
  repoPath: string;
}

function useRowConnection({
  server,
  deviceToken,
  projectSlug,
  sentryProject,
}: Omit<BaseRowMeta, "name" | "repoPath">) {
  const remote = isRemote(server);
  const headers = useMemo(
    () => (remote ? targetHeaders(server, deviceToken, projectSlug, sentryProject) : undefined),
    [remote, server, deviceToken, projectSlug, sentryProject],
  );
  const conn = useMcpConnectionStatus(remote ? server : null, { headers });
  return { remote, headers, conn };
}

// --- Forge built-in row ---

interface ForgeServerRowProps extends BaseRowMeta {}

export function ForgeServerRow(props: ForgeServerRowProps) {
  const { server, repoPath } = props;
  const { remote, headers, conn } = useRowConnection(props);
  const [expanded, setExpanded] = useState(false);
  const inspectorId = "mcp-tools-forge";

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot status={conn.state.status} remote={remote} />
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
              {conn.state.status === "ok" && conn.state.toolsCount != null && (
                <span className="ml-2 text-[10px] text-gray-500">
                  {conn.state.toolsCount} tools
                </span>
              )}
            </p>
            <p className="text-xs text-gray-400">{server.url}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void conn.ping()}
            disabled={conn.state.status === "pinging"}
            className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:opacity-50"
          >
            {conn.state.status === "pinging" ? "Pinging…" : "Test"}
          </button>
          <InspectorChevron
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            controlsId={inspectorId}
          />
          <McpCliInstallPicker
            name="forge"
            server={server}
            repoPath={repoPath}
            compact
          />
        </div>
      </div>
      <McpToolsInspector
        id={inspectorId}
        server={server}
        expanded={expanded}
        headers={headers}
      />
    </div>
  );
}

// --- Library server row ---

interface LibraryServerRowProps extends BaseRowMeta {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

export function LibraryServerRow(props: LibraryServerRowProps) {
  const { name, server, enabled, onToggle, onRemove, repoPath } = props;
  const { remote, headers, conn } = useRowConnection(props);
  const [expanded, setExpanded] = useState(false);
  const inspectorId = `mcp-tools-lib-${name}`;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot status={conn.state.status} remote={remote} />
          <Toggle enabled={enabled} onToggle={() => onToggle(!enabled)} />
          <div>
            <p className="text-sm font-medium text-gray-800">
              {name}
              {remote && (
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
        <div className="flex items-center gap-1">
          {remote && (
            <button
              type="button"
              onClick={() => void conn.ping()}
              disabled={conn.state.status === "pinging"}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:opacity-50"
            >
              {conn.state.status === "pinging" ? "Pinging…" : "Test"}
            </button>
          )}
          <InspectorChevron
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            controlsId={inspectorId}
          />
          <McpCliInstallPicker
            name={name}
            server={server}
            repoPath={repoPath}
            compact
          />
          <button
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600"
          >
            Remove
          </button>
        </div>
      </div>
      <McpToolsInspector
        id={inspectorId}
        server={server}
        expanded={expanded}
        headers={headers}
      />
    </div>
  );
}

// --- Project server row ---

interface ProjectServerRowProps extends BaseRowMeta {
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

export function ProjectServerRow(props: ProjectServerRowProps) {
  const { name, server, onToggle, onEdit, onRemove, repoPath } = props;
  const enabled = server.enabled ?? true;
  const { remote, headers, conn } = useRowConnection(props);
  const [expanded, setExpanded] = useState(false);
  const inspectorId = `mcp-tools-proj-${name}`;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot status={conn.state.status} remote={remote} />
          <Toggle enabled={enabled} onToggle={onToggle} />
          <div>
            <p className="text-sm font-medium text-gray-800">
              {name}
              {remote && (
                <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">
                  remote
                </span>
              )}
            </p>
            <p className="text-xs text-gray-400">{serverSubtitle(server)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {remote && (
            <button
              type="button"
              onClick={() => void conn.ping()}
              disabled={conn.state.status === "pinging"}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200 disabled:opacity-50"
            >
              {conn.state.status === "pinging" ? "Pinging…" : "Test"}
            </button>
          )}
          <InspectorChevron
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            controlsId={inspectorId}
          />
          <McpCliInstallPicker
            name={name}
            server={server}
            repoPath={repoPath}
            compact
          />
          <button
            onClick={onEdit}
            aria-label={`Edit ${name}`}
            className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-200"
          >
            Edit
          </button>
          <button
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600"
          >
            Remove
          </button>
        </div>
      </div>
      <McpToolsInspector
        id={inspectorId}
        server={server}
        expanded={expanded}
        headers={headers}
      />
    </div>
  );
}
