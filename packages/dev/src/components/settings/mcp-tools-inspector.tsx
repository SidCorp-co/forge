import { useMemo, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { useMcpTools, type McpToolEntry } from "@/hooks/use-mcp-tools";
import { isRemote } from "./mcp-server-list/helpers";
import { Skeleton } from "@/components/ui";

interface McpToolsInspectorProps {
  id?: string;
  server: McpServerConfig;
  expanded: boolean;
  headers?: Record<string, string>;
}

function ToolRow({ tool }: { tool: McpToolEntry }) {
  const desc = tool.description ?? "";
  const truncated = desc.length > 120 ? `${desc.slice(0, 120)}…` : desc;
  return (
    <li className="flex items-baseline gap-2 px-3 py-1">
      <code className="shrink-0 rounded bg-gray-100 px-1 py-0.5 font-mono text-xs text-gray-800">
        {tool.name}
      </code>
      <span className="truncate text-xs text-gray-500" title={desc || undefined}>
        {truncated}
      </span>
    </li>
  );
}

function ToolGroup({
  title,
  tools,
}: {
  title: string;
  tools: McpToolEntry[];
}) {
  const [open, setOpen] = useState(true);
  if (tools.length === 0) return null;
  return (
    <div className="border-t border-gray-100 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50"
      >
        <span>
          {title} <span className="text-gray-400">({tools.length})</span>
        </span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="divide-y divide-gray-50">
          {tools.map((t) => (
            <ToolRow key={t.name} tool={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function McpToolsInspector({
  id,
  server,
  expanded,
  headers,
}: McpToolsInspectorProps) {
  const remote = isRemote(server);
  const { tools, loading, error, refetch } = useMcpTools(server, expanded && remote, {
    headers,
  });
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!tools) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => {
      const desc = t.description ?? "";
      return t.name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
    });
  }, [tools, filter]);

  const admin = useMemo(
    () => (filtered ?? []).filter((t) => t.name.startsWith("admin/")),
    [filtered],
  );
  const project = useMemo(
    () => (filtered ?? []).filter((t) => !t.name.startsWith("admin/")),
    [filtered],
  );

  if (!expanded) return null;

  return (
    <div id={id} className="mt-2 rounded-md border border-gray-200 bg-white">
      {!remote ? (
        <p className="px-3 py-2 text-xs text-gray-500">
          Local server — cannot inspect tools from the desktop UI.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tools…"
              aria-label="Filter tools"
              className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={refetch}
              className="shrink-0 rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>

          {loading && (
            <div className="space-y-2 px-3 py-2">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-2 text-xs text-red-600">
              Could not list tools: {error}{" "}
              <button
                type="button"
                onClick={refetch}
                className="ml-2 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && tools && tools.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500">This server exposes no tools.</p>
          )}

          {!loading && !error && filtered && filtered.length === 0 && tools && tools.length > 0 && (
            <p className="px-3 py-2 text-xs text-gray-500">
              No tools match &ldquo;{filter}&rdquo;.
            </p>
          )}

          {!loading && !error && filtered && filtered.length > 0 && (
            <>
              <ToolGroup title="Admin tools" tools={admin} />
              <ToolGroup title="Project tools" tools={project} />
            </>
          )}
        </>
      )}
    </div>
  );
}
