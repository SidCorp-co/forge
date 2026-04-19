import { useState } from "react";
import type { McpServerConfig } from "@/lib/types";

interface McpServerEditorProps {
  name: string;
  server: McpServerConfig;
  onSave: (name: string, server: McpServerConfig) => void;
  onCancel: () => void;
  isNew?: boolean;
}

export function McpServerEditor({ name: initialName, server, onSave, onCancel, isNew }: McpServerEditorProps) {
  const isInitialRemote = server.type === "http" || server.type === "sse" || !!server.url;
  const [name, setName] = useState(initialName);
  const [mode, setMode] = useState<"local" | "remote">(isInitialRemote ? "remote" : "local");

  // Local fields
  const [command, setCommand] = useState(server.command ?? "");
  const [args, setArgs] = useState(server.args?.join("\n") ?? "");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>(
    server.env ? Object.entries(server.env).map(([key, value]) => ({ key, value })) : [],
  );

  // Remote fields
  const [url, setUrl] = useState(server.url ?? "");
  const [headerPairs, setHeaderPairs] = useState<{ key: string; value: string }[]>(
    server.headers ? Object.entries(server.headers).map(([key, value]) => ({ key, value })) : [],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    if (mode === "remote") {
      if (!url.trim()) return;
      const headers: Record<string, string> = {};
      for (const { key, value } of headerPairs) {
        if (key.trim()) headers[key.trim()] = value;
      }
      onSave(name.trim(), {
        type: "http",
        url: url.trim(),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        enabled: server.enabled ?? true,
      });
    } else {
      if (!command.trim()) return;
      const parsedArgs = args.split("\n").map((a) => a.trim()).filter(Boolean);
      const parsedEnv: Record<string, string> = {};
      for (const { key, value } of envPairs) {
        if (key.trim()) parsedEnv[key.trim()] = value;
      }
      onSave(name.trim(), {
        command: command.trim(),
        args: parsedArgs.length > 0 ? parsedArgs : undefined,
        env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
        enabled: server.enabled ?? true,
      });
    }
  }

  function addEnvPair() { setEnvPairs([...envPairs, { key: "", value: "" }]); }
  function updateEnvPair(idx: number, field: "key" | "value", val: string) {
    const updated = [...envPairs]; updated[idx] = { ...updated[idx], [field]: val }; setEnvPairs(updated);
  }
  function removeEnvPair(idx: number) { setEnvPairs(envPairs.filter((_, i) => i !== idx)); }

  function addHeaderPair() { setHeaderPairs([...headerPairs, { key: "", value: "" }]); }
  function updateHeaderPair(idx: number, field: "key" | "value", val: string) {
    const updated = [...headerPairs]; updated[idx] = { ...updated[idx], [field]: val }; setHeaderPairs(updated);
  }
  function removeHeaderPair(idx: number) { setHeaderPairs(headerPairs.filter((_, i) => i !== idx)); }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Server Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. my-mcp-server"
          disabled={!isNew}
          className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
        />
      </div>

      {/* Type toggle */}
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-600">Type</label>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("local")}
            className={`rounded px-3 py-1 text-xs ${mode === "local" ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            Local (stdio)
          </button>
          <button
            type="button"
            onClick={() => setMode("remote")}
            className={`rounded px-3 py-1 text-xs ${mode === "remote" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            Remote (URL)
          </button>
        </div>
      </div>

      {mode === "local" ? (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="e.g. node, npx, python3"
              className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Arguments (one per line)</label>
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={"e.g. /path/to/server.js\n--port\n3000"}
              rows={3}
              className="w-full rounded border border-gray-200 bg-white px-2 py-1 font-mono text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">Environment Variables</label>
              <button type="button" onClick={addEnvPair} className="text-xs text-blue-600 hover:text-blue-800">+ Add</button>
            </div>
            {envPairs.map((pair, idx) => (
              <div key={idx} className="mb-1 flex gap-1">
                <input type="text" value={pair.key} onChange={(e) => updateEnvPair(idx, "key", e.target.value)} placeholder="KEY" className="w-1/3 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none" />
                <input type="text" value={pair.value} onChange={(e) => updateEnvPair(idx, "value", e.target.value)} placeholder="value" className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none" />
                <button type="button" onClick={() => removeEnvPair(idx)} className="px-1 text-xs text-red-400 hover:text-red-600">x</button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g. http://localhost:1337/mcp"
              className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">Headers</label>
              <button type="button" onClick={addHeaderPair} className="text-xs text-blue-600 hover:text-blue-800">+ Add</button>
            </div>
            {headerPairs.map((pair, idx) => (
              <div key={idx} className="mb-1 flex gap-1">
                <input type="text" value={pair.key} onChange={(e) => updateHeaderPair(idx, "key", e.target.value)} placeholder="Header-Name" className="w-1/3 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none" />
                <input type="text" value={pair.value} onChange={(e) => updateHeaderPair(idx, "value", e.target.value)} placeholder="value" className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-xs focus:border-blue-400 focus:outline-none" />
                <button type="button" onClick={() => removeHeaderPair(idx)} className="px-1 text-xs text-red-400 hover:text-red-600">x</button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex gap-2">
        <button type="submit" className="rounded bg-black px-4 py-1.5 text-xs text-white hover:bg-gray-800">
          {isNew ? "Add" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-gray-200 px-4 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </form>
  );
}
