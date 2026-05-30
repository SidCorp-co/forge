"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";
import { Input } from "@/design/primitives/input";
import { Kbd } from "@/design/primitives/kbd";

export interface Command {
  label: string;
  icon: IconName;
  kbd?: string;
  onRun?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const filtered = useMemo(
    () => commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
    [commands, query],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[active];
        if (cmd) {
          cmd.onRun?.();
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, active, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
      style={{ background: "rgba(24,27,34,0.25)", backdropFilter: "blur(8px)" }}
      onClick={onClose}
    >
      <div
        className="forge-drop w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
          <Icon name="search" size={18} className="text-subtle" />
          <Input
            variant="bare"
            className="flex-1"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search or run a command…"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-[340px] overflow-y-auto p-1.5">
          {filtered.length === 0 && <li className="fg-body-sm px-3 py-6 text-center">No matches.</li>}
          {filtered.map((cmd, i) => (
            <li key={cmd.label}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  cmd.onRun?.();
                  onClose();
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm",
                  i === active ? "bg-accent-tint text-accent-text" : "text-fg hover:bg-hover",
                )}
              >
                <Icon name={cmd.icon} size={17} style={i === active ? { color: "var(--accent)" } : { color: "var(--fg-subtle)" }} />
                <span className="flex-1">{cmd.label}</span>
                {cmd.kbd && <Kbd>{cmd.kbd}</Kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
