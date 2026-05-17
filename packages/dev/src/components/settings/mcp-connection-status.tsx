import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { McpServerConfig } from "@/lib/types";
import { useMcpConnectionStatus } from "@/hooks/use-mcp-connection-status";
import { previewHeaders, targetHeaders } from "./mcp-server-list/helpers";
import { AlertBanner } from "@/components/ui";

interface McpConnectionStatusProps {
  coreUrl: string | null;
  projectSlug: string | undefined;
  sentryProject: string | undefined;
  deviceToken: string | null;
  forgeServer: McpServerConfig | null;
}

function hostOnly(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function tail4(token: string | null | undefined): string {
  if (!token) return "";
  return token.slice(-4);
}

const KEYCHAIN_SERVICE: string =
  ((import.meta.env as Record<string, string | undefined>).VITE_APP_NAMESPACE as string) ||
  "forge-beta";

export function McpConnectionStatus({
  coreUrl,
  projectSlug,
  sentryProject,
  deviceToken,
  forgeServer,
}: McpConnectionStatusProps) {
  const headers = useMemo(
    () =>
      forgeServer
        ? targetHeaders(forgeServer, deviceToken, projectSlug, sentryProject)
        : undefined,
    [forgeServer, deviceToken, projectSlug, sentryProject],
  );
  const { state, ping } = useMcpConnectionStatus(forgeServer, { headers });
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (forgeServer) void ping();
    // initial probe on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!copyMsg) return;
    const t = setTimeout(() => setCopyMsg(null), 2000);
    return () => clearTimeout(t);
  }, [copyMsg]);

  async function handleCopyHeaders() {
    if (!headers) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(previewHeaders(headers), null, 2),
      );
      setCopyMsg("Headers copied to clipboard");
    } catch {
      setCopyMsg("Could not copy — clipboard blocked");
    }
  }

  const tokenOk = !!deviceToken;
  const urlOk = !!coreUrl;
  const slugOk = !!projectSlug;
  const pingStatus = state.status;
  const pingColor =
    pingStatus === "ok"
      ? "text-green-600"
      : pingStatus === "degraded"
        ? "text-amber-600"
        : pingStatus === "unreachable"
          ? "text-red-600"
          : "text-gray-500";

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          MCP connection
        </div>
        <ul className="divide-y divide-gray-100 text-sm">
          <li className="flex items-center justify-between px-4 py-2">
            <span className="text-gray-700">Device token</span>
            <span className="flex items-center gap-2">
              {tokenOk ? (
                <>
                  <span aria-hidden className="text-green-600">●</span>
                  <span className="font-mono text-xs text-gray-700">
                    Paired (••••{tail4(deviceToken)})
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden className="text-red-600">●</span>
                  <span className="text-red-700">Not paired</span>
                  <Link
                    to="/settings"
                    className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                  >
                    Re-pair device
                  </Link>
                </>
              )}
            </span>
          </li>

          <li className="flex items-center justify-between px-4 py-2">
            <span className="text-gray-700">Core URL</span>
            <span className="flex items-center gap-2">
              {urlOk ? (
                <>
                  <span aria-hidden className="text-green-600">●</span>
                  <span className="font-mono text-xs text-gray-700">
                    {hostOnly(coreUrl)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void ping()}
                    disabled={!forgeServer || pingStatus === "pinging"}
                    className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {pingStatus === "pinging" ? "Pinging…" : "Test connection"}
                  </button>
                  <span className={`text-xs ${pingColor}`}>
                    {pingStatus === "ok" && state.latencyMs != null && `${state.latencyMs}ms`}
                    {pingStatus === "degraded" && "degraded"}
                    {pingStatus === "unreachable" && (state.error ?? "unreachable")}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden className="text-red-600">●</span>
                  <span className="text-red-700">Not configured</span>
                </>
              )}
            </span>
          </li>

          <li className="flex items-center justify-between px-4 py-2">
            <span className="text-gray-700">Project header</span>
            <span className="flex items-center gap-2">
              {slugOk ? (
                <>
                  <span aria-hidden className="text-green-600">●</span>
                  <span className="font-mono text-xs text-gray-700">
                    X-Forge-Project-Slug: {projectSlug}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden className="text-amber-600">●</span>
                  <span className="text-amber-700">Not set</span>
                </>
              )}
              <button
                type="button"
                onClick={handleCopyHeaders}
                disabled={!headers}
                aria-label="Copy headers preview to clipboard"
                className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Copy headers
              </button>
            </span>
          </li>

          <li className="flex items-center justify-between px-4 py-2">
            <span className="text-gray-700">Keychain service</span>
            <span className="font-mono text-xs text-gray-500">{KEYCHAIN_SERVICE}</span>
          </li>
        </ul>
        {copyMsg && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 py-1.5 text-xs text-gray-600">
            {copyMsg}
          </div>
        )}
      </div>

      {!tokenOk && (
        <AlertBanner variant="error">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Device token missing</p>
              <p className="text-xs">
                Forge MCP will return 401 until this device is re-paired. Keychain service:{" "}
                <span className="font-mono">{KEYCHAIN_SERVICE}</span>
              </p>
            </div>
            <Link
              to="/settings"
              className="shrink-0 rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Re-pair device
            </Link>
          </div>
        </AlertBanner>
      )}

      {tokenOk && pingStatus === "unreachable" && state.error?.includes("401") && (
        <AlertBanner variant="error">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold">Token expired or rejected</p>
              <p className="text-xs">Forge core returned 401. Re-pair device to refresh credentials.</p>
            </div>
            <Link
              to="/settings"
              className="shrink-0 rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            >
              Re-pair device
            </Link>
          </div>
        </AlertBanner>
      )}

      {tokenOk && !slugOk && (
        <AlertBanner variant="warning">
          No project header set — multi-tenant tools will be unscoped.
        </AlertBanner>
      )}
    </div>
  );
}
