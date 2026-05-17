import { useEffect, useRef, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { Modal } from "@/components/ui";
import { McpPasteParser } from "./mcp-paste-parser";
import { McpServerEditor } from "./mcp-server-editor";

type WizardTab = "paste" | "manual" | "library" | "forge";

const TABS: { id: WizardTab; label: string }[] = [
  { id: "paste", label: "Paste JSON" },
  { id: "manual", label: "Manual" },
  { id: "library", label: "From Library" },
  { id: "forge", label: "Forge built-in" },
];

interface McpServerWizardProps {
  open: boolean;
  initialTab?: WizardTab;
  onClose: () => void;
  onPasteAdd: (servers: Record<string, McpServerConfig>) => void;
  onManualAdd: (name: string, server: McpServerConfig) => void;
  libraryServers: Record<string, McpServerConfig>;
  enabledLibraryServers: string[];
  onLibraryToggle?: (name: string, enabled: boolean) => void;
  coreUrl: string | null;
  projectSlug: string | undefined;
}

export function McpServerWizard({
  open,
  initialTab = "paste",
  onClose,
  onPasteAdd,
  onManualAdd,
  libraryServers,
  enabledLibraryServers,
  onLibraryToggle,
  coreUrl,
  projectSlug,
}: McpServerWizardProps) {
  const [tab, setTab] = useState<WizardTab>(initialTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next =
        e.key === "ArrowRight"
          ? (idx + 1) % TABS.length
          : (idx - 1 + TABS.length) % TABS.length;
      setTab(TABS[next].id);
      tabRefs.current[next]?.focus();
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <div className="border-b border-gray-100 px-5 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Add MCP server</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ✕
          </button>
        </div>
        <div role="tablist" className="mt-3 flex gap-1 text-xs">
          {TABS.map((t, idx) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`mcp-wizard-panel-${t.id}`}
              id={`mcp-wizard-tab-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, idx)}
              className={`rounded px-3 py-1.5 ${
                tab === t.id
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {tab === "paste" && (
          <div role="tabpanel" id="mcp-wizard-panel-paste" aria-labelledby="mcp-wizard-tab-paste">
            <McpPasteParser
              onAdd={(servers) => {
                onPasteAdd(servers);
                onClose();
              }}
              onCancel={onClose}
            />
          </div>
        )}

        {tab === "manual" && (
          <div role="tabpanel" id="mcp-wizard-panel-manual" aria-labelledby="mcp-wizard-tab-manual">
            <McpServerEditor
              name=""
              server={{ command: "", enabled: true }}
              isNew
              onSave={(name, server) => {
                onManualAdd(name, server);
                onClose();
              }}
              onCancel={onClose}
            />
          </div>
        )}

        {tab === "library" && (
          <div
            role="tabpanel"
            id="mcp-wizard-panel-library"
            aria-labelledby="mcp-wizard-tab-library"
            className="space-y-2"
          >
            {Object.keys(libraryServers).length === 0 ? (
              <p className="text-xs text-gray-500">
                No library MCP servers yet. Use the Paste JSON tab to add some.
              </p>
            ) : (
              Object.entries(libraryServers).map(([name, server]) => {
                const enabled = enabledLibraryServers.includes(name);
                return (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded border border-gray-200 bg-white px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-800">{name}</p>
                      <p className="font-mono text-[11px] text-gray-400">
                        {server.url ?? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onLibraryToggle?.(name, !enabled)}
                      className={`rounded px-3 py-1 text-xs ${
                        enabled
                          ? "bg-gray-200 text-gray-600 hover:bg-gray-300"
                          : "bg-blue-600 text-white hover:bg-blue-700"
                      }`}
                    >
                      {enabled ? "Disable" : "Enable for this project"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "forge" && (
          <div
            role="tabpanel"
            id="mcp-wizard-panel-forge"
            aria-labelledby="mcp-wizard-tab-forge"
            className="space-y-3 text-sm text-gray-700"
          >
            <p>
              The Forge built-in MCP server is auto-wired when this device is paired. It
              exposes project tools (issues, comments, jobs, pipeline runs) plus admin
              tools.
            </p>
            <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs">
              <p className="mb-1 text-gray-500">Endpoint</p>
              <p className="font-mono text-gray-700">{coreUrl ? `${coreUrl}/mcp` : "—"}</p>
              <p className="mb-1 mt-2 text-gray-500">Project header</p>
              <p className="font-mono text-gray-700">
                X-Forge-Project-Slug: {projectSlug ?? "<not set>"}
              </p>
            </div>
            <p className="text-xs text-gray-500">
              For non-desktop MCP clients, issue a Personal Access Token from the web
              Settings page and use it as the Bearer token.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
