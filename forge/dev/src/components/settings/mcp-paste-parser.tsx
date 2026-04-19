import { useState, useMemo } from "react";
import { parseMcpInput } from "@/lib/parse-mcp-input";
import type { McpServerConfig } from "@/lib/types";

interface McpPasteParserProps {
  onAdd: (servers: Record<string, McpServerConfig>) => void;
  onCancel: () => void;
}

export function McpPasteParser({ onAdd, onCancel }: McpPasteParserProps) {
  const [text, setText] = useState("");

  const parsed = useMemo(() => parseMcpInput(text), [text]);
  const entries = Object.entries(parsed);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-800">Paste MCP Config</h3>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Paste JSON, URL, or command:\n{"mcpServers": {...}}\nhttps://mcp.example.com\nnpx -y @org/server'}
        rows={5}
        className="mb-3 w-full rounded border border-gray-300 px-3 py-2 font-mono text-xs focus:border-gray-500 focus:outline-none"
      />

      {entries.length > 0 && (
        <div className="mb-3 space-y-1">
          {entries.map(([name, cfg]) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className="text-green-600">&#10003;</span>
              <span className="font-medium text-gray-700">{name}</span>
              <span className="text-gray-400">
                ({cfg.type || cfg.url ? "remote" : "local stdio"})
              </span>
            </div>
          ))}
        </div>
      )}

      {text.trim() && entries.length === 0 && (
        <p className="mb-3 text-xs text-amber-600">Could not detect any MCP server configs.</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onAdd(parsed)}
          disabled={entries.length === 0}
          className="rounded bg-black px-4 py-1.5 text-xs text-white hover:bg-gray-800 disabled:opacity-50"
        >
          Add to Library
        </button>
        <button
          onClick={onCancel}
          className="rounded bg-gray-200 px-4 py-1.5 text-xs text-gray-600 hover:bg-gray-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
