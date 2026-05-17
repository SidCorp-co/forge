import { useEffect, useMemo, useRef, useState } from "react";
import type { McpServerConfig } from "@/lib/types";
import { invoke } from "@/hooks/use-tauri-ipc";
import { Sentry, isSentryEnabled } from "@/lib/sentry";

export type CliTarget = "claude-cli" | "cursor" | "cline" | "zed" | "custom";

const TARGETS: { id: CliTarget; label: string }[] = [
  { id: "claude-cli", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "cline", label: "Cline" },
  { id: "zed", label: "Zed" },
  { id: "custom", label: "Custom path…" },
];

const LAST_TARGET_KEY = "mcp.lastCliTarget";

function readLastTarget(): CliTarget {
  try {
    const v = localStorage.getItem(LAST_TARGET_KEY);
    if (v && TARGETS.some((t) => t.id === v)) return v as CliTarget;
  } catch {
    // localStorage disabled — fall through
  }
  return "claude-cli";
}

function writeLastTarget(t: CliTarget) {
  try {
    localStorage.setItem(LAST_TARGET_KEY, t);
  } catch {
    // ignore — storage unavailable
  }
}

interface McpCliInstallPickerProps {
  name: string;
  server: McpServerConfig;
  repoPath: string;
  compact?: boolean;
}

function expandHomeForDisplay(path: string): string {
  if (path.startsWith("~/")) return path;
  return path;
}

function destinationPreview(target: CliTarget, repoPath: string, customPath: string): string {
  switch (target) {
    case "claude-cli":
      return `${repoPath || "<repo>"}/.mcp.json`;
    case "cursor":
      return "~/.cursor/mcp.json";
    case "cline":
      return `${repoPath || "<repo>"}/.vscode/settings.json`;
    case "zed":
      return "~/.config/zed/settings.json";
    case "custom":
      return customPath || "(choose a path)";
  }
}

export function McpCliInstallPicker({
  name,
  server,
  repoPath,
  compact = false,
}: McpCliInstallPickerProps) {
  const [target, setTarget] = useState<CliTarget>(() => readLastTarget());
  const [customPath, setCustomPath] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "pending" | "ok" | "err">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeLastTarget(target);
  }, [target]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const destination = useMemo(
    () => destinationPreview(target, repoPath, customPath),
    [target, repoPath, customPath],
  );

  async function handleInstall() {
    if (target === "custom" && !customPath.trim()) {
      setStatus("err");
      setErrorMsg("Choose a destination path");
      return;
    }
    setStatus("pending");
    setErrorMsg(null);
    try {
      await invoke("install_mcp_to_cli", {
        name,
        server,
        repoPath: repoPath ?? "",
        target,
        customPath: target === "custom" ? customPath.trim() : null,
      });
      setStatus("ok");
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: "mcp.cli.install",
          data: { target, ok: true },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus("err");
      setErrorMsg(message);
      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: "mcp.cli.install",
          message,
          data: { target, ok: false },
        });
      }
    }
  }

  const statusLabel =
    status === "pending"
      ? "Installing…"
      : status === "ok"
        ? "Installed"
        : status === "err"
          ? "Failed"
          : "Install";
  const statusClass =
    status === "ok"
      ? "text-green-600"
      : status === "err"
        ? "text-red-500"
        : "text-blue-500 hover:bg-blue-50";

  return (
    <div ref={wrapperRef} className="relative inline-flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Select install target"
          className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
        >
          {TARGETS.find((t) => t.id === target)?.label ?? "Claude Code"}{" "}
          <span aria-hidden>▾</span>
        </button>
        <button
          type="button"
          onClick={handleInstall}
          disabled={status === "pending"}
          className={`rounded px-2 py-1 text-xs ${statusClass} disabled:opacity-50`}
        >
          {statusLabel}
        </button>
      </div>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 w-56 rounded-md border border-gray-200 bg-white p-1 shadow-lg"
        >
          {TARGETS.map((t) => (
            <button
              key={t.id}
              role="menuitemradio"
              aria-checked={target === t.id}
              type="button"
              onClick={() => {
                setTarget(t.id);
                if (t.id !== "custom") setOpen(false);
                setStatus("idle");
                setErrorMsg(null);
              }}
              className={`block w-full rounded px-2 py-1 text-left text-xs ${
                target === t.id ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {t.label}
            </button>
          ))}
          {target === "custom" && (
            <div className="mt-1 border-t border-gray-100 p-2">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-500">
                Absolute path
              </label>
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder="/absolute/path/to/config.json"
                className="w-full rounded border border-gray-200 px-2 py-1 font-mono text-[11px] focus:border-blue-400 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-gray-500">
                Must be an absolute path.
              </p>
            </div>
          )}
        </div>
      )}

      {!compact && (
        <p className="font-mono text-[10px] text-gray-400">
          → {expandHomeForDisplay(destination)}
        </p>
      )}
      {status === "err" && errorMsg && (
        <p className="text-[10px] text-red-500">{errorMsg}</p>
      )}
    </div>
  );
}
